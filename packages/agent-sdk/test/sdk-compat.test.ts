/**
 * M6 SDK-compat smoke test — raw fetch against our own routes, exercising
 * the exact shapes an @anthropic-ai/sdk client would produce against a
 * localhost `baseURL` override. The shipped SDK doesn't currently expose
 * managed-agents-2026-04-01 endpoints, so raw fetch with the proper
 * `anthropic-beta` header is the right level of coverage.
 *
 * Flow:
 *   1. Create agent
 *   2. List agents, assert {data, next_page} shape
 *   3. Create environment, poll ready
 *   4. Create session
 *   5. Send user.message
 *   6. Stream a few events, assert SSE id/event/data lines and JSON shape
 *   7. POST invalid event type, assert error envelope shape
 *   8. Archive session
 *   9. Archive environment (now that session is terminated)
 *
 * Requires SPRITE_TOKEN + CLAUDE_CODE_OAUTH_TOKEN. Skipped otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Load .env
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

const PORT = Number(process.env.CA_TEST_PORT ?? 4104);
const BASE = `http://localhost:${PORT}`;

type ServerHandle = { proc: import("node:child_process").ChildProcess; apiKey: string };

async function bootServer(): Promise<ServerHandle> {
  const { spawn } = await import("node:child_process");
  const dbDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, `test-sdk-compat-${Date.now()}.db`);

  const proc = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    env: { ...process.env, DATABASE_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let apiKey = "";
  const logChunks: string[] = [];
  const onData = (buf: Buffer): void => {
    const s = buf.toString("utf8");
    logChunks.push(s);
    const m = s.match(/key:\s+(ck_[A-Za-z0-9_-]+)/);
    if (m) apiKey = m[1];
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch {
      /* not ready */
    }
  }

  await fetch(`${BASE}/v1/agents`, { headers: { "x-api-key": "x" } }).catch(() => {});
  for (let i = 0; i < 20 && !apiKey; i++) {
    await sleep(200);
  }
  if (!apiKey) {
    console.error("server log:", logChunks.join("").slice(-2000));
    throw new Error("failed to obtain API key from server output");
  }
  return { proc, apiKey };
}

async function stopServer(h: ServerHandle): Promise<void> {
  h.proc.kill("SIGTERM");
  await sleep(500);
  if (!h.proc.killed) h.proc.kill("SIGKILL");
}

async function cleanupSprites(): Promise<void> {
  const token = process.env.SPRITE_TOKEN;
  if (!token) return;
  const api = process.env.SPRITE_API || "https://api.sprites.dev";
  const res = await fetch(`${api}/v1/sprites?prefix=ca-sess-`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return;
  const data = (await res.json()) as { sprites: Array<{ name: string }> };
  for (const s of data.sprites ?? []) {
    await fetch(`${api}/v1/sprites/${encodeURIComponent(s.name)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
}

describe("M6 SDK compat smoke", () => {
  if (!process.env.SPRITE_TOKEN || !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    it.skip("skipping: creds not set", () => {});
    return;
  }

  let server: ServerHandle;

  beforeAll(async () => {
    server = await bootServer();
  }, 120_000);

  afterAll(async () => {
    await stopServer(server);
    await cleanupSprites();
  }, 30_000);

  it("full CRUD + message + stream + archive flow with managed-agents beta header", async () => {
    const key = server.apiKey;
    const H = {
      "x-api-key": key,
      "content-type": "application/json",
      "anthropic-beta": "managed-agents-2026-04-01",
    };

    // 1. Create agent
    const agentRes = await fetch(`${BASE}/v1/agents`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        name: "sdk-compat",
        model: "claude-sonnet-4-6",
        tools: [{ type: "agent_toolset_20260401" }],
      }),
    });
    expect(agentRes.ok).toBe(true);
    const agent = (await agentRes.json()) as { id: string; version: number; name: string };
    expect(agent.id).toMatch(/^agent_/);
    expect(agent.name).toBe("sdk-compat");

    // 2. List agents — expect managed-agents list shape
    const listRes = await fetch(`${BASE}/v1/agents?limit=10`, { headers: H });
    expect(listRes.ok).toBe(true);
    const listBody = (await listRes.json()) as {
      data: Array<{ id: string }>;
      next_page: string | null;
    };
    expect(Array.isArray(listBody.data)).toBe(true);
    expect(listBody.data.length).toBeGreaterThan(0);
    expect("next_page" in listBody).toBe(true);

    // 3. Create env, poll ready
    const envRes = await fetch(`${BASE}/v1/environments`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        name: "sdk-compat-env",
        config: { type: "cloud", networking: { type: "unrestricted" } },
      }),
    });
    const env = (await envRes.json()) as { id: string; state: string };
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`${BASE}/v1/environments/${env.id}`, { headers: H });
      const e = (await r.json()) as { state: string };
      if (e.state === "ready") break;
      if (e.state === "failed") throw new Error("env setup failed");
      await sleep(1000);
    }

    // 4. Create session
    const sessRes = await fetch(`${BASE}/v1/sessions`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ agent: agent.id, environment_id: env.id }),
    });
    expect(sessRes.ok).toBe(true);
    const session = (await sessRes.json()) as { id: string; agent: { id: string; version: number } };
    const sid = session.id;
    expect(sid).toMatch(/^sess_/);

    // 5. Open stream, collect events
    const sseLines: string[] = [];
    const collected: Array<{ seq: number; type: string }> = [];
    const abortCtl = new AbortController();
    const streamPromise = (async () => {
      const r = await fetch(`${BASE}/v1/sessions/${sid}/stream`, {
        headers: { "x-api-key": key, Accept: "text/event-stream" },
        signal: abortCtl.signal,
      });
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n\n");
          buf = lines.pop() || "";
          for (const block of lines) {
            sseLines.push(block);
            const m = block.match(/^data: (.+)$/m);
            if (!m) continue;
            try {
              const d = JSON.parse(m[1]) as { seq?: number; type: string };
              if (d.seq != null) collected.push({ seq: d.seq, type: d.type });
            } catch {
              /* ping */
            }
          }
        }
      } catch {
        /* aborted */
      }
    })();

    await sleep(500);

    // 6. Send a user.message
    await fetch(`${BASE}/v1/sessions/${sid}/events`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Say 'hello' and nothing else." }],
          },
        ],
      }),
    });

    // Wait for the turn to finish
    for (let i = 0; i < 60; i++) {
      if (collected.some((e) => e.type === "session.status_idle")) break;
      await sleep(1000);
    }

    // SSE shape assertions: every real event has id:, event:, and data:
    const realBlocks = sseLines.filter((b) => b.includes("event:"));
    expect(realBlocks.length).toBeGreaterThan(0);
    for (const block of realBlocks) {
      expect(block).toMatch(/^id: \d+/m);
      expect(block).toMatch(/^event: [a-z.]+/m);
      expect(block).toMatch(/^data: \{/m);
    }

    expect(collected.some((e) => e.type === "session.status_running")).toBe(true);
    expect(collected.some((e) => e.type === "session.status_idle")).toBe(true);

    // 7. Error envelope: POST an invalid event type
    const badRes = await fetch(`${BASE}/v1/sessions/${sid}/events`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ events: [{ type: "user.bogus" }] }),
    });
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(badBody.type).toBe("error");
    expect(badBody.error.type).toBe("invalid_request_error");

    // 8. Archive the session
    const archRes = await fetch(`${BASE}/v1/sessions/${sid}/archive`, {
      method: "POST",
      headers: H,
    });
    expect(archRes.ok).toBe(true);
    const archBody = (await archRes.json()) as { id: string; archived_at: string | null };
    expect(archBody.archived_at).not.toBeNull();

    // 9. Archive the env — should succeed now that the session is archived
    const envArchRes = await fetch(`${BASE}/v1/environments/${env.id}/archive`, {
      method: "POST",
      headers: H,
    });
    expect(envArchRes.ok).toBe(true);
    const envArchBody = (await envArchRes.json()) as { id: string; archived_at: string | null };
    expect(envArchBody.archived_at).not.toBeNull();

    abortCtl.abort();
    await streamPromise.catch(() => {});
  }, 240_000);
});
