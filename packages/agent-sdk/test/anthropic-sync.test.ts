/**
 * Anthropic sync — unit tests for syncAgent.
 *
 * Covers the fields the sync sends to Anthropic's /v1/agents endpoint:
 *   - tools (explicit config passed through)
 *   - tools (defaulted to full built-in toolset when agent has none)
 *   - mcp_servers converted from Record → array
 *   - config hash idempotency (no re-sync when unchanged)
 *   - model_config included only when non-empty
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-sync-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  delete g.__caActors;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function stubFetch(responders: Array<(call: FetchCall) => unknown>): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
    const opts = (init ?? {}) as RequestInit;
    const rawHeaders = (opts.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    const body = opts.body ? JSON.parse(opts.body as string) : null;
    const call: FetchCall = {
      url: String(url),
      method: (opts.method ?? "GET").toUpperCase(),
      headers,
      body,
    };
    calls.push(call);
    const responder = responders[calls.length - 1];
    if (!responder) {
      throw new Error(`No stub configured for fetch call #${calls.length} (${call.method} ${call.url})`);
    }
    const payload = responder(call);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("syncAgent", () => {
  let fetchStub: ReturnType<typeof stubFetch> | null = null;

  beforeEach(() => {
    freshDbEnv();
  });

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = null;
  });

  it("passes agent.tools through to Anthropic when configured", async () => {
    const { createAgent } = await import("../src/db/agents");
    const { syncAgent } = await import("../src/sync/anthropic");

    const agent = createAgent({
      name: "tester",
      model: "claude-sonnet-4-6",
      tools: [
        { type: "agent_toolset_20260401", configs: [{ name: "Bash", enabled: false }] },
        { type: "custom", name: "myTool", description: "x", input_schema: {} },
      ],
    });

    fetchStub = stubFetch([
      () => ({ id: "remote_agent_123" }),
    ]);

    const remoteId = await syncAgent(agent.id, [], "sk-ant-test");
    expect(remoteId).toBe("remote_agent_123");
    expect(fetchStub.calls).toHaveLength(1);
    const body = fetchStub.calls[0].body!;
    expect(body.tools).toEqual([
      { type: "agent_toolset_20260401", configs: [{ name: "Bash", enabled: false }] },
      { type: "custom", name: "myTool", description: "x", input_schema: {} },
    ]);
  });

  it("defaults tools to full built-in toolset when agent has none", async () => {
    const { createAgent } = await import("../src/db/agents");
    const { syncAgent } = await import("../src/sync/anthropic");

    const agent = createAgent({
      name: "bare",
      model: "claude-sonnet-4-6",
      // tools omitted — DB will store []
    });

    fetchStub = stubFetch([() => ({ id: "remote_bare" })]);
    await syncAgent(agent.id, [], "sk-ant-test");

    const body = fetchStub.calls[0].body!;
    expect(body.tools).toEqual([{ type: "agent_toolset_20260401" }]);
  });

  it("converts mcp_servers from Record to array format", async () => {
    const { createAgent } = await import("../src/db/agents");
    const { syncAgent } = await import("../src/sync/anthropic");

    const agent = createAgent({
      name: "mcp-agent",
      model: "claude-sonnet-4-6",
      mcp_servers: {
        github: { type: "sse", url: "https://mcp.github.com" },
        stripe: { type: "http", url: "https://mcp.stripe.com" },
      },
    });

    fetchStub = stubFetch([() => ({ id: "remote_mcp" })]);
    await syncAgent(agent.id, [], "sk-ant-test");

    const body = fetchStub.calls[0].body!;
    expect(body.mcp_servers).toEqual([
      { name: "github", type: "sse", url: "https://mcp.github.com" },
      { name: "stripe", type: "http", url: "https://mcp.stripe.com" },
    ]);
  });

  it("omits mcp_servers and model_config when empty", async () => {
    const { createAgent } = await import("../src/db/agents");
    const { syncAgent } = await import("../src/sync/anthropic");

    const agent = createAgent({
      name: "minimal",
      model: "claude-sonnet-4-6",
    });

    fetchStub = stubFetch([() => ({ id: "remote_min" })]);
    await syncAgent(agent.id, [], "sk-ant-test");

    const body = fetchStub.calls[0].body!;
    expect(body).not.toHaveProperty("mcp_servers");
    expect(body).not.toHaveProperty("model_config");
  });

  it("sends required anthropic headers (x-api-key, anthropic-version, anthropic-beta)", async () => {
    const { createAgent } = await import("../src/db/agents");
    const { syncAgent } = await import("../src/sync/anthropic");

    const agent = createAgent({ name: "hdr", model: "claude-sonnet-4-6" });

    fetchStub = stubFetch([() => ({ id: "remote_hdr" })]);
    await syncAgent(agent.id, [], "sk-ant-my-key");

    const headers = fetchStub.calls[0].headers;
    expect(headers["x-api-key"]).toBe("sk-ant-my-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe("managed-agents-2026-04-01");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("is idempotent — same config returns the cached remote id without a second call", async () => {
    const { createAgent } = await import("../src/db/agents");
    const { syncAgent } = await import("../src/sync/anthropic");

    const agent = createAgent({ name: "idem", model: "claude-sonnet-4-6" });

    fetchStub = stubFetch([() => ({ id: "remote_idem" })]);

    const first = await syncAgent(agent.id, [], "sk-ant-test");
    const second = await syncAgent(agent.id, [], "sk-ant-test");
    expect(first).toBe("remote_idem");
    expect(second).toBe("remote_idem");
    expect(fetchStub.calls).toHaveLength(1); // only created once
  });

  it("throws on non-ok response with a useful message", async () => {
    const { createAgent } = await import("../src/db/agents");
    const { syncAgent } = await import("../src/sync/anthropic");

    const agent = createAgent({ name: "err", model: "claude-sonnet-4-6" });

    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response("bad model", { status: 400 }),
    ) as typeof globalThis.fetch;
    try {
      await expect(syncAgent(agent.id, [], "sk-ant-test")).rejects.toThrow(/400.*bad model/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
