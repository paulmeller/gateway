// @ts-nocheck — test file with loose typing on handler responses
/**
 * Multi-agent orchestration tests.
 *
 * Covers:
 * - Create coordinator with multiagent config, verify stored
 * - multiagent agents roster validation (max 20)
 * - multiagent sets threads_enabled + callable_agents for backward compat
 * - Thread CRUD (create, list, get, archive)
 * - Thread archive only when idle
 * - Max 25 threads enforced
 * - Thread handlers (list, get, archive via HTTP)
 * - session_threads table migration
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-multiagent-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
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

async function bootDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-12345" });
  return key;
}

function req(
  url: string,
  opts: { method?: string; body?: unknown; apiKey?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.apiKey !== undefined) {
    if (opts.apiKey !== "") headers["x-api-key"] = opts.apiKey;
  } else {
    headers["x-api-key"] = "test-api-key-12345";
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function createTestAgent(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { handleCreateAgent } = await import("../src/handlers/agents");
  const res = await handleCreateAgent(
    req("/v1/agents", {
      body: { name: `Agent-${Date.now()}-${Math.random()}`, model: { id: "claude-sonnet-4-6" }, ...overrides },
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

async function createTestEnv(): Promise<Record<string, unknown>> {
  const { getDb } = await import("../src/db/client");
  const { newId } = await import("../src/util/ids");
  const { nowMs, toIso } = await import("../src/util/clock");

  const db = getDb();
  const id = newId("env");
  const now = nowMs();
  db.prepare(`INSERT INTO environments (id, name, config_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id, `env-${Date.now()}`, JSON.stringify({ type: "self_hosted", provider: "docker" }), "ready", now, now,
  );
  return { id, type: "environment", name: `env-${Date.now()}` };
}

async function createTestSession(agentId: string, envId: string): Promise<Record<string, unknown>> {
  const { createSession } = await import("../src/db/sessions");
  const { getAgent } = await import("../src/db/agents");
  const agent = getAgent(agentId)!;
  const session = createSession({
    agent_id: agent.id,
    agent_version: agent.version,
    environment_id: envId,
  });
  return session as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Multi-Agent: multiagent config on agents", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("creates agent with multiagent coordinator config", async () => {
    await bootDb();
    const agent = await createTestAgent({
      multiagent: {
        type: "coordinator",
        agents: [
          { type: "agent", id: "agent_abc" },
          { type: "agent", id: "agent_def", version: 2 },
          { type: "self" },
        ],
      },
    });

    expect(agent.multiagent).toBeDefined();
    expect(agent.multiagent.type).toBe("coordinator");
    expect(agent.multiagent.agents).toHaveLength(3);
    expect(agent.multiagent.agents[0]).toEqual({ type: "agent", id: "agent_abc" });
    expect(agent.multiagent.agents[1]).toEqual({ type: "agent", id: "agent_def", version: 2 });
    expect(agent.multiagent.agents[2]).toEqual({ type: "self" });
  });

  it("multiagent sets threads_enabled true for backward compat", async () => {
    await bootDb();
    const agent = await createTestAgent({
      multiagent: {
        type: "coordinator",
        agents: [{ type: "agent", id: "agent_abc" }],
      },
    });

    expect(agent.threads_enabled).toBe(true);
  });

  it("multiagent derives callable_agents from roster for backward compat", async () => {
    await bootDb();
    const agent = await createTestAgent({
      multiagent: {
        type: "coordinator",
        agents: [
          { type: "agent", id: "agent_abc" },
          { type: "self" },
          { type: "agent", id: "agent_def", version: 3 },
        ],
      },
    });

    // callable_agents should only include type=agent entries (not self)
    expect(agent.callable_agents).toHaveLength(2);
    expect(agent.callable_agents[0]).toEqual({ type: "agent", id: "agent_abc" });
    expect(agent.callable_agents[1]).toEqual({ type: "agent", id: "agent_def", version: 3 });
  });

  it("agent without multiagent does not have it in response", async () => {
    await bootDb();
    const agent = await createTestAgent();
    expect(agent.multiagent).toBeUndefined();
    expect(agent.threads_enabled).toBe(false);
  });

  it("rejects multiagent with more than 20 agents", async () => {
    await bootDb();
    const agents = Array.from({ length: 21 }, (_, i) => ({ type: "agent", id: `agent_${i}` }));
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(
      req("/v1/agents", {
        body: {
          name: `Agent-${Date.now()}`,
          model: { id: "claude-sonnet-4-6" },
          multiagent: { type: "coordinator", agents },
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("persists multiagent across versions (update)", async () => {
    await bootDb();
    const agent = await createTestAgent({
      multiagent: {
        type: "coordinator",
        agents: [{ type: "agent", id: "agent_abc" }],
      },
    });

    const { handleUpdateAgent } = await import("../src/handlers/agents");
    const res = await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, {
        body: {
          version: agent.version,
          name: "Updated Agent",
        },
      }),
      agent.id as string,
    );
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.multiagent).toBeDefined();
    expect(updated.multiagent.agents).toHaveLength(1);
    expect(updated.threads_enabled).toBe(true);
  });

  it("can update multiagent roster", async () => {
    await bootDb();
    const agent = await createTestAgent({
      multiagent: {
        type: "coordinator",
        agents: [{ type: "agent", id: "agent_abc" }],
      },
    });

    const { handleUpdateAgent } = await import("../src/handlers/agents");
    const res = await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, {
        body: {
          version: agent.version,
          multiagent: {
            type: "coordinator",
            agents: [
              { type: "agent", id: "agent_abc" },
              { type: "agent", id: "agent_xyz" },
              { type: "self" },
            ],
          },
        },
      }),
      agent.id as string,
    );
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.multiagent.agents).toHaveLength(3);
  });

  it("can clear multiagent by passing null", async () => {
    await bootDb();
    const agent = await createTestAgent({
      multiagent: {
        type: "coordinator",
        agents: [{ type: "agent", id: "agent_abc" }],
      },
    });

    const { handleUpdateAgent } = await import("../src/handlers/agents");
    const res = await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, {
        body: {
          version: agent.version,
          multiagent: null,
        },
      }),
      agent.id as string,
    );
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.multiagent).toBeUndefined();
  });

  it("getAgent returns multiagent from DB", async () => {
    await bootDb();
    const created = await createTestAgent({
      multiagent: {
        type: "coordinator",
        agents: [{ type: "self" }],
      },
    });

    const { getAgent } = await import("../src/db/agents");
    const agent = getAgent(created.id as string);
    expect(agent).toBeDefined();
    expect(agent!.multiagent).toBeDefined();
    expect(agent!.multiagent!.type).toBe("coordinator");
    expect(agent!.multiagent!.agents[0]).toEqual({ type: "self" });
    expect(agent!.threads_enabled).toBe(true);
  });
});

describe("Multi-Agent: session_threads CRUD", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("creates a thread and retrieves it", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread, getThread } = await import("../src/db/threads");
    const thread = createThread({
      sessionId: session.id as string,
      agentId: agent.id as string,
      agentVersion: agent.version as number,
    });

    expect(thread.type).toBe("session_thread");
    expect(thread.id).toMatch(/^sth_/);
    expect(thread.session_id).toBe(session.id);
    expect(thread.status).toBe("idle");
    expect(thread.agent.id).toBe(agent.id);
    expect(thread.usage.input_tokens).toBe(0);

    const fetched = getThread(session.id as string, thread.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(thread.id);
  });

  it("lists threads for a session", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread, listThreads } = await import("../src/db/threads");
    createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });
    createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });

    const threads = listThreads(session.id as string);
    expect(threads).toHaveLength(2);
  });

  it("archives an idle thread", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread, archiveThread } = await import("../src/db/threads");
    const thread = createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });

    const archived = archiveThread(session.id as string, thread.id);
    expect(archived).toBeDefined();
    expect(archived!.archived_at).not.toBeNull();
  });

  it("rejects archive of running thread", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread, archiveThread, updateThreadStatus } = await import("../src/db/threads");
    const thread = createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });
    updateThreadStatus(thread.id, "running");

    expect(() => archiveThread(session.id as string, thread.id)).toThrow(/must be idle/);
  });

  it("enforces max 25 threads per session", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread } = await import("../src/db/threads");
    for (let i = 0; i < 25; i++) {
      createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });
    }

    expect(() =>
      createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number }),
    ).toThrow(/max threads per session/);
  });

  it("updateThreadStatus changes status and stop_reason", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread, getThread, updateThreadStatus } = await import("../src/db/threads");
    const thread = createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });

    updateThreadStatus(thread.id, "running");
    let fetched = getThread(session.id as string, thread.id)!;
    expect(fetched.status).toBe("running");

    updateThreadStatus(thread.id, "idle", "end_turn");
    fetched = getThread(session.id as string, thread.id)!;
    expect(fetched.status).toBe("idle");
    expect(fetched.stop_reason).toBe("end_turn");
  });

  it("updateThreadUsage accumulates usage", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread, getThread, updateThreadUsage } = await import("../src/db/threads");
    const thread = createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });

    updateThreadUsage(thread.id, { input_tokens: 100, output_tokens: 50 });
    let fetched = getThread(session.id as string, thread.id)!;
    expect(fetched.usage.input_tokens).toBe(100);
    expect(fetched.usage.output_tokens).toBe(50);

    updateThreadUsage(thread.id, { input_tokens: 200, output_tokens: 30 });
    fetched = getThread(session.id as string, thread.id)!;
    expect(fetched.usage.input_tokens).toBe(300);
    expect(fetched.usage.output_tokens).toBe(80);
  });

  it("getThread returns undefined for wrong session", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread, getThread } = await import("../src/db/threads");
    const thread = createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });

    const fetched = getThread("sesn_nonexistent", thread.id);
    expect(fetched).toBeUndefined();
  });

  it("countActiveThreads works correctly", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread, archiveThread, countActiveThreads } = await import("../src/db/threads");
    createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });
    const t2 = createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });

    expect(countActiveThreads(session.id as string)).toBe(2);

    archiveThread(session.id as string, t2.id);
    expect(countActiveThreads(session.id as string)).toBe(1);
  });
});

describe("Multi-Agent: thread handlers", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("handleListThreads returns threads for a session", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread } = await import("../src/db/threads");
    createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });
    createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });

    const { handleListThreads } = await import("../src/handlers/threads");
    const res = await handleListThreads(
      req(`/v1/sessions/${session.id}/threads`),
      session.id as string,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].type).toBe("session_thread");
  });

  it("handleGetThread returns a specific thread", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread } = await import("../src/db/threads");
    const thread = createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });

    const { handleGetThread } = await import("../src/handlers/threads");
    const res = await handleGetThread(
      req(`/v1/sessions/${session.id}/threads/${thread.id}`),
      session.id as string,
      thread.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(thread.id);
    expect(body.type).toBe("session_thread");
  });

  it("handleGetThread returns 404 for nonexistent thread", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { handleGetThread } = await import("../src/handlers/threads");
    const res = await handleGetThread(
      req(`/v1/sessions/${session.id}/threads/sth_nonexistent`),
      session.id as string,
      "sth_nonexistent",
    );
    expect(res.status).toBe(404);
  });

  it("handleArchiveThread archives an idle thread", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread } = await import("../src/db/threads");
    const thread = createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });

    const { handleArchiveThread } = await import("../src/handlers/threads");
    const res = await handleArchiveThread(
      req(`/v1/sessions/${session.id}/threads/${thread.id}/archive`, { method: "POST" }),
      session.id as string,
      thread.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived_at).not.toBeNull();
  });

  it("handleArchiveThread rejects non-idle thread", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const session = await createTestSession(agent.id as string, env.id as string);

    const { createThread } = await import("../src/db/threads");
    const { updateThreadStatus } = await import("../src/db/threads");
    const thread = createThread({ sessionId: session.id as string, agentId: agent.id as string, agentVersion: agent.version as number });
    updateThreadStatus(thread.id, "running");

    const { handleArchiveThread } = await import("../src/handlers/threads");
    const res = await handleArchiveThread(
      req(`/v1/sessions/${session.id}/threads/${thread.id}/archive`, { method: "POST" }),
      session.id as string,
      thread.id,
    );
    expect(res.status).toBe(400);
  });

  it("handleListThreads returns 404 for nonexistent session", async () => {
    await bootDb();
    const { handleListThreads } = await import("../src/handlers/threads");
    const res = await handleListThreads(
      req("/v1/sessions/sesn_nonexistent/threads"),
      "sesn_nonexistent",
    );
    expect(res.status).toBe(404);
  });
});

describe("Multi-Agent: session_threads migration", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("session_threads table exists after migration", async () => {
    await bootDb();
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_threads'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it("events table has thread_id column", async () => {
    await bootDb();
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === "thread_id")).toBe(true);
  });

  it("agent_versions table has multiagent_json column", async () => {
    await bootDb();
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(agent_versions)").all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === "multiagent_json")).toBe(true);
  });
});
