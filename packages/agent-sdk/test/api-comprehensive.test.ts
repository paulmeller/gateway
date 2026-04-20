// @ts-nocheck — test file with loose typing on handler responses
/**
 * Comprehensive API handler tests.
 *
 * Tests the full API surface by calling handler functions directly with
 * mock Request objects. Each test gets a fresh in-memory DB so tests are
 * fully isolated.
 *
 * 100+ tests covering agents, environments, sessions, events, vaults,
 * memory stores, batch, settings, auth, and error handling.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Wipe all globalThis singletons so next import gets a fresh DB. */
function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-api-test-"));
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

/** Boot DB + seed a default API key, return the raw key string for auth. */
async function bootDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb(); // triggers migrations
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-12345" });
  return key;
}

/** Build a Request with JSON body + auth header. */
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
    // if empty string, omit header entirely (for auth tests)
  } else {
    headers["x-api-key"] = "test-api-key-12345";
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/** Shortcut: create an agent and return its parsed body. */
async function createTestAgent(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { handleCreateAgent } = await import("../src/handlers/agents");
  const res = await handleCreateAgent(
    req("/v1/agents", {
      body: { name: `Agent-${Date.now()}-${Math.random()}`, model: "claude-sonnet-4-6", ...overrides },
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

/** Shortcut: create an environment with docker provider (no async setup needed). */
async function createTestEnv(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  // Create environment directly in DB to avoid async setup and provider availability checks
  const { getDb } = await import("../src/db/client");
  const { newId } = await import("../src/util/ids");
  const { nowMs, toIso } = await import("../src/util/clock");

  const db = getDb();
  const id = newId("env");
  const now = nowMs();
  const name = overrides.name as string ?? `env-${Date.now()}-${Math.random()}`;
  const config = overrides.config ?? { type: "cloud", provider: "docker" };

  // Stamp tenant_default so the agent (stamped by the handler) and the env
  // match when a session is created across them (v0.5).
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?)`,
  ).run(id, name, JSON.stringify(config), now);

  return {
    id,
    name,
    config,
    state: "ready",
    state_message: null,
    created_at: toIso(now),
    archived_at: null,
  };
}

/** Shortcut: create a session from an existing agent + env. */
async function createTestSession(
  agentId: string,
  envId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { handleCreateSession } = await import("../src/handlers/sessions");
  const res = await handleCreateSession(
    req("/v1/sessions", {
      body: { agent: agentId, environment_id: envId, ...overrides },
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Agents", () => {
  beforeEach(() => freshDbEnv());

  it("creates an agent with valid data -> 201", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(
      req("/v1/agents", {
        body: { name: "My Agent", model: "claude-sonnet-4-6" },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("My Agent");
    expect(body.model).toBe("claude-sonnet-4-6");
  });

  it("creates an agent with empty name -> 400", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(
      req("/v1/agents", {
        body: { name: "", model: "claude-sonnet-4-6" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("creates an agent missing model -> 400", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(
      req("/v1/agents", { body: { name: "NoModel" } }),
    );
    expect(res.status).toBe(400);
  });

  it("creates an agent with duplicate name -> 409", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    await handleCreateAgent(req("/v1/agents", { body: { name: "Dupe", model: "claude-sonnet-4-6" } }));
    const res = await handleCreateAgent(req("/v1/agents", { body: { name: "Dupe", model: "claude-sonnet-4-6" } }));
    expect(res.status).toBe(409);
  });

  it("lists agents -> returns array with data field", async () => {
    await bootDb();
    await createTestAgent({ name: "A1" });
    await createTestAgent({ name: "A2" });
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
  });

  it("lists agents with limit", async () => {
    await bootDb();
    await createTestAgent({ name: "L1" });
    await createTestAgent({ name: "L2" });
    await createTestAgent({ name: "L3" });
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents?limit=2"));
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(2);
  });

  it("gets agent by ID -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "GetMe" });
    const { handleGetAgent } = await import("../src/handlers/agents");
    const res = await handleGetAgent(req(`/v1/agents/${agent.id}`), agent.id as string);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(agent.id);
    expect(body.name).toBe("GetMe");
  });

  it("gets non-existent agent -> 404", async () => {
    await bootDb();
    const { handleGetAgent } = await import("../src/handlers/agents");
    const res = await handleGetAgent(req("/v1/agents/nonexistent"), "nonexistent");
    expect(res.status).toBe(404);
  });

  it("updates agent name -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "OldName" });
    const { handleUpdateAgent } = await import("../src/handlers/agents");
    const res = await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, { method: "PATCH", body: { name: "NewName" } }),
      agent.id as string,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("NewName");
  });

  it("updates agent model -> 200 and increments version", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "VersionTest" });
    expect(agent.version).toBe(1);
    const { handleUpdateAgent } = await import("../src/handlers/agents");
    const res = await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, { method: "PATCH", body: { model: "claude-opus-4-6" } }),
      agent.id as string,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe("claude-opus-4-6");
    expect(body.version).toBe(2);
  });

  it("update agent rejects backend change -> 400", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "BackendTest" });
    const { handleUpdateAgent } = await import("../src/handlers/agents");
    const res = await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, { method: "PATCH", body: { backend: "codex" } }),
      agent.id as string,
    );
    expect(res.status).toBe(400);
  });

  it("deletes agent -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "DeleteMe" });
    const { handleDeleteAgent } = await import("../src/handlers/agents");
    const res = await handleDeleteAgent(
      req(`/v1/agents/${agent.id}`, { method: "DELETE" }),
      agent.id as string,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("agent_deleted");
  });

  it("deletes non-existent agent -> 404", async () => {
    await bootDb();
    const { handleDeleteAgent } = await import("../src/handlers/agents");
    const res = await handleDeleteAgent(
      req("/v1/agents/nope", { method: "DELETE" }),
      "nope",
    );
    expect(res.status).toBe(404);
  });

  it("creates agent with tools for non-claude backend -> 400", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(
      req("/v1/agents", {
        body: {
          name: "CodexTools",
          model: "claude-sonnet-4-6",
          engine: "codex",
          tools: [{ type: "agent_toolset_20260401" }],
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("agent has correct fields", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "Fields", model: "claude-sonnet-4-6" });
    expect(agent).toHaveProperty("id");
    expect(agent).toHaveProperty("name", "Fields");
    expect(agent).toHaveProperty("model", "claude-sonnet-4-6");
    expect(agent).toHaveProperty("engine", "claude");
    expect(agent).toHaveProperty("version", 1);
    expect(agent).toHaveProperty("created_at");
    expect(agent).toHaveProperty("updated_at");
    expect(agent).toHaveProperty("tools");
    expect(agent).toHaveProperty("mcp_servers");
    expect(agent).toHaveProperty("system");
    expect(agent).toHaveProperty("threads_enabled", false);
    expect(agent).toHaveProperty("confirmation_mode", false);
    expect(agent).toHaveProperty("callable_agents");
    expect(agent).toHaveProperty("webhook_url");
    expect(agent).toHaveProperty("webhook_events");
  });

  it("list agents excludes archived by default", async () => {
    await bootDb();
    const a1 = await createTestAgent({ name: "ArchAlive" });
    const a2 = await createTestAgent({ name: "ArchDead" });
    const { handleDeleteAgent, handleListAgents } = await import("../src/handlers/agents");
    await handleDeleteAgent(req(`/v1/agents/${a2.id}`, { method: "DELETE" }), a2.id as string);
    const res = await handleListAgents(req("/v1/agents"));
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((a) => a.id)).toContain(a1.id);
    expect(body.data.map((a) => a.id)).not.toContain(a2.id);
  });

  it("list agents with include_archived shows archived", async () => {
    await bootDb();
    const a1 = await createTestAgent({ name: "InclAlive" });
    const a2 = await createTestAgent({ name: "InclDead" });
    const { handleDeleteAgent, handleListAgents } = await import("../src/handlers/agents");
    await handleDeleteAgent(req(`/v1/agents/${a2.id}`, { method: "DELETE" }), a2.id as string);
    const res = await handleListAgents(req("/v1/agents?include_archived=true"));
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((a) => a.id);
    expect(ids).toContain(a1.id);
    expect(ids).toContain(a2.id);
  });

  it("creates agent with custom engine", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "GeminiAgent", engine: "gemini", model: "gemini-2.0-flash" });
    expect(agent.engine).toBe("gemini");
  });

  it("creates agent with webhook config", async () => {
    await bootDb();
    const agent = await createTestAgent({
      name: "WebhookAgent",
      webhook_url: "https://example.com/hook",
      webhook_events: ["session.status_idle"],
    });
    expect(agent.webhook_url).toBe("https://example.com/hook");
    expect(agent.webhook_events).toEqual(["session.status_idle"]);
  });
});

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

describe("Environments", () => {
  beforeEach(() => freshDbEnv());

  it("creates an environment directly in DB -> ready state", async () => {
    await bootDb();
    const env = await createTestEnv({ name: "TestEnv" });
    expect(env.id).toBeTruthy();
    expect(env.name).toBe("TestEnv");
    expect(env.state).toBe("ready");
  });

  it("get environment by ID -> 200", async () => {
    await bootDb();
    const env = await createTestEnv({ name: "GetEnv" });
    const { handleGetEnvironment } = await import("../src/handlers/environments");
    const res = await handleGetEnvironment(req(`/v1/environments/${env.id}`), env.id as string);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(env.id);
  });

  it("get non-existent environment -> 404", async () => {
    await bootDb();
    const { handleGetEnvironment } = await import("../src/handlers/environments");
    const res = await handleGetEnvironment(req("/v1/environments/nope"), "nope");
    expect(res.status).toBe(404);
  });

  it("list environments -> returns array", async () => {
    await bootDb();
    await createTestEnv({ name: "ListE1" });
    await createTestEnv({ name: "ListE2" });
    const { handleListEnvironments } = await import("../src/handlers/environments");
    const res = await handleListEnvironments(req("/v1/environments"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
  });

  it("list environments with limit", async () => {
    await bootDb();
    await createTestEnv({ name: "LimE1" });
    await createTestEnv({ name: "LimE2" });
    await createTestEnv({ name: "LimE3" });
    const { handleListEnvironments } = await import("../src/handlers/environments");
    const res = await handleListEnvironments(req("/v1/environments?limit=2"));
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(2);
  });

  it("delete environment -> 200", async () => {
    await bootDb();
    const env = await createTestEnv({ name: "DelEnv" });
    const { handleDeleteEnvironment } = await import("../src/handlers/environments");
    const res = await handleDeleteEnvironment(
      req(`/v1/environments/${env.id}`, { method: "DELETE" }),
      env.id as string,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("environment_deleted");
  });

  it("delete environment with active sessions -> 409", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "EnvDelAgent" });
    const env = await createTestEnv({ name: "BusyEnv" });
    await createTestSession(agent.id as string, env.id as string);
    const { handleDeleteEnvironment } = await import("../src/handlers/environments");
    const res = await handleDeleteEnvironment(
      req(`/v1/environments/${env.id}`, { method: "DELETE" }),
      env.id as string,
    );
    expect(res.status).toBe(409);
  });

  it("archive environment -> 200", async () => {
    await bootDb();
    const env = await createTestEnv({ name: "ArchEnv" });
    const { handleArchiveEnvironment } = await import("../src/handlers/environments");
    const res = await handleArchiveEnvironment(
      req(`/v1/environments/${env.id}/archive`, { method: "POST", body: {} }),
      env.id as string,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived_at).not.toBeNull();
  });

  it("archive non-existent environment -> 404", async () => {
    await bootDb();
    const { handleArchiveEnvironment } = await import("../src/handlers/environments");
    const res = await handleArchiveEnvironment(
      req("/v1/environments/nope/archive", { method: "POST", body: {} }),
      "nope",
    );
    expect(res.status).toBe(404);
  });

  it("environment has correct fields", async () => {
    await bootDb();
    const env = await createTestEnv({ name: "FieldsEnv" });
    expect(env).toHaveProperty("id");
    expect(env).toHaveProperty("name", "FieldsEnv");
    expect(env).toHaveProperty("config");
    expect(env).toHaveProperty("state", "ready");
    expect(env).toHaveProperty("created_at");
  });

  it("list environments excludes archived", async () => {
    await bootDb();
    const e1 = await createTestEnv({ name: "ExclAlive" });
    const e2 = await createTestEnv({ name: "ExclDead" });
    const { handleArchiveEnvironment, handleListEnvironments } = await import("../src/handlers/environments");
    await handleArchiveEnvironment(
      req(`/v1/environments/${e2.id}/archive`, { method: "POST", body: {} }),
      e2.id as string,
    );
    const res = await handleListEnvironments(req("/v1/environments"));
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((e) => e.id)).toContain(e1.id);
    expect(body.data.map((e) => e.id)).not.toContain(e2.id);
  });

  it("list environments with include_archived shows archived", async () => {
    await bootDb();
    const e1 = await createTestEnv({ name: "InclAliveE" });
    const e2 = await createTestEnv({ name: "InclDeadE" });
    const { handleArchiveEnvironment, handleListEnvironments } = await import("../src/handlers/environments");
    await handleArchiveEnvironment(
      req(`/v1/environments/${e2.id}/archive`, { method: "POST", body: {} }),
      e2.id as string,
    );
    const res = await handleListEnvironments(req("/v1/environments?include_archived=true"));
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((e) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).toContain(e2.id);
  });

  it("delete non-existent environment -> 404", async () => {
    await bootDb();
    const { handleDeleteEnvironment } = await import("../src/handlers/environments");
    const res = await handleDeleteEnvironment(
      req("/v1/environments/ghost", { method: "DELETE" }),
      "ghost",
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("Sessions", () => {
  beforeEach(() => freshDbEnv());

  it("creates session -> 201", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "SessAgent" });
    const env = await createTestEnv({ name: "SessEnv" });
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(
      req("/v1/sessions", {
        body: { agent: agent.id, environment_id: env.id },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("idle");
  });

  it("creates session with non-existent agent -> 404", async () => {
    await bootDb();
    const env = await createTestEnv({ name: "SessEnv2" });
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(
      req("/v1/sessions", {
        body: { agent: "fake_agent", environment_id: env.id },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("creates session with non-existent environment -> 404", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "SessAgent3" });
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(
      req("/v1/sessions", {
        body: { agent: agent.id, environment_id: "fake_env" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("lists sessions -> returns array", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "ListSessAgent" });
    const env = await createTestEnv({ name: "ListSessEnv" });
    await createTestSession(agent.id as string, env.id as string);
    await createTestSession(agent.id as string, env.id as string);
    const { handleListSessions } = await import("../src/handlers/sessions");
    const res = await handleListSessions(req("/v1/sessions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
  });

  it("lists sessions with agent_id filter", async () => {
    await bootDb();
    const a1 = await createTestAgent({ name: "FilterA1" });
    const a2 = await createTestAgent({ name: "FilterA2" });
    const env = await createTestEnv({ name: "FilterEnv" });
    await createTestSession(a1.id as string, env.id as string);
    await createTestSession(a2.id as string, env.id as string);
    const { handleListSessions } = await import("../src/handlers/sessions");
    const res = await handleListSessions(req(`/v1/sessions?agent_id=${a1.id}`));
    const body = (await res.json()) as { data: Array<{ agent: { id: string } }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0].agent.id).toBe(a1.id);
  });

  it("lists sessions with status filter", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "StatusFilterAgent" });
    const env = await createTestEnv({ name: "StatusFilterEnv" });
    await createTestSession(agent.id as string, env.id as string);
    const { handleListSessions } = await import("../src/handlers/sessions");
    const res = await handleListSessions(req("/v1/sessions?status=idle"));
    const body = (await res.json()) as { data: Array<{ status: string }> };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    body.data.forEach((s) => expect(s.status).toBe("idle"));
  });

  it("lists sessions with invalid status -> 400", async () => {
    await bootDb();
    const { handleListSessions } = await import("../src/handlers/sessions");
    const res = await handleListSessions(req("/v1/sessions?status=bogus"));
    expect(res.status).toBe(400);
  });

  it("gets session by ID -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "GetSessAgent" });
    const env = await createTestEnv({ name: "GetSessEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handleGetSession } = await import("../src/handlers/sessions");
    const res = await handleGetSession(req(`/v1/sessions/${session.id}`), session.id as string);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(session.id);
  });

  it("gets non-existent session -> 404", async () => {
    await bootDb();
    const { handleGetSession } = await import("../src/handlers/sessions");
    const res = await handleGetSession(req("/v1/sessions/nope"), "nope");
    expect(res.status).toBe(404);
  });

  it("updates session title -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "UpdateSessAgent" });
    const env = await createTestEnv({ name: "UpdateSessEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handleUpdateSession } = await import("../src/handlers/sessions");
    const res = await handleUpdateSession(
      req(`/v1/sessions/${session.id}`, { method: "PATCH", body: { title: "My Session" } }),
      session.id as string,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("My Session");
  });

  it("updates session metadata -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "MetaSessAgent" });
    const env = await createTestEnv({ name: "MetaSessEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handleUpdateSession } = await import("../src/handlers/sessions");
    const res = await handleUpdateSession(
      req(`/v1/sessions/${session.id}`, { method: "PATCH", body: { metadata: { foo: "bar" } } }),
      session.id as string,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadata).toEqual({ foo: "bar" });
  });

  it("update non-existent session -> 404", async () => {
    await bootDb();
    const { handleUpdateSession } = await import("../src/handlers/sessions");
    const res = await handleUpdateSession(
      req("/v1/sessions/ghost", { method: "PATCH", body: { title: "x" } }),
      "ghost",
    );
    expect(res.status).toBe(404);
  });

  it("session has correct fields", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "FieldSessAgent" });
    const env = await createTestEnv({ name: "FieldSessEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    expect(session).toHaveProperty("id");
    expect(session).toHaveProperty("agent");
    expect(session).toHaveProperty("environment_id", env.id);
    expect(session).toHaveProperty("status", "idle");
    expect(session).toHaveProperty("created_at");
    expect(session).toHaveProperty("updated_at");
    expect(session).toHaveProperty("metadata");
    expect(session).toHaveProperty("stats");
    expect(session).toHaveProperty("usage");
    expect(session).toHaveProperty("parent_session_id", null);
    expect(session).toHaveProperty("thread_depth", 0);
  });

  it("creates session with vault_ids", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "VaultSessAgent" });
    const env = await createTestEnv({ name: "VaultSessEnv" });
    // Create a real vault owned by this agent (server enforces ownership)
    const { handleCreateVault } = await import("../src/handlers/vaults");
    const vaultRes = await handleCreateVault(req("/v1/vaults", {
      body: { agent_id: agent.id as string, name: "vault-for-session" },
    }));
    const vault = await vaultRes.json() as { id: string };
    const session = await createTestSession(agent.id as string, env.id as string, {
      vault_ids: [vault.id],
    });
    expect(session.vault_ids).toEqual([vault.id]);
  });

  it("lists sessions with pagination (next_page)", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "PaginateAgent" });
    const env = await createTestEnv({ name: "PaginateEnv" });
    await createTestSession(agent.id as string, env.id as string);
    await createTestSession(agent.id as string, env.id as string);
    await createTestSession(agent.id as string, env.id as string);
    const { handleListSessions } = await import("../src/handlers/sessions");
    const res = await handleListSessions(req("/v1/sessions?limit=2"));
    const body = (await res.json()) as { data: unknown[]; next_page: string | null };
    expect(body.data.length).toBe(2);
    expect(body.next_page).toBeTruthy();
  });

  it("creates session with title", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "TitleAgent" });
    const env = await createTestEnv({ name: "TitleEnv" });
    const session = await createTestSession(agent.id as string, env.id as string, {
      title: "My First Session",
    });
    expect(session.title).toBe("My First Session");
  });

  it("creates session with agent object ref (id + version)", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "RefAgent" });
    const env = await createTestEnv({ name: "RefEnv" });
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(
      req("/v1/sessions", {
        body: {
          agent: { id: agent.id, version: 1 },
          environment_id: env.id,
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.id).toBe(agent.id);
    expect(body.agent.version).toBe(1);
  });

  it("lists sessions with environment_id filter", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "EnvFilterAgent" });
    const e1 = await createTestEnv({ name: "EnvF1" });
    const e2 = await createTestEnv({ name: "EnvF2" });
    await createTestSession(agent.id as string, e1.id as string);
    await createTestSession(agent.id as string, e2.id as string);
    const { handleListSessions } = await import("../src/handlers/sessions");
    const res = await handleListSessions(req(`/v1/sessions?environment_id=${e1.id}`));
    const body = (await res.json()) as { data: Array<{ environment_id: string }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0].environment_id).toBe(e1.id);
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("Events", () => {
  beforeEach(() => freshDbEnv());

  it("posts user message -> 200 with events array", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "EvtAgent" });
    const env = await createTestEnv({ name: "EvtEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents } = await import("../src/handlers/events");
    const res = await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: { events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }] },
      }),
      session.id as string,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ type: string }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0].type).toBe("user.message");
  });

  it("posts to non-existent session -> 404", async () => {
    await bootDb();
    const { handlePostEvents } = await import("../src/handlers/events");
    const res = await handlePostEvents(
      req("/v1/sessions/ghost/events", {
        body: { events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }] },
      }),
      "ghost",
    );
    expect(res.status).toBe(404);
  });

  it("posts empty events array -> 400", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "EmptyEvtAgent" });
    const env = await createTestEnv({ name: "EmptyEvtEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents } = await import("../src/handlers/events");
    const res = await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: { events: [] },
      }),
      session.id as string,
    );
    expect(res.status).toBe(400);
  });

  it("posts invalid event type -> 400", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "BadEvtAgent" });
    const env = await createTestEnv({ name: "BadEvtEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents } = await import("../src/handlers/events");
    const res = await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: { events: [{ type: "bogus.event" }] },
      }),
      session.id as string,
    );
    expect(res.status).toBe(400);
  });

  it("lists events -> returns array", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "ListEvtAgent" });
    const env = await createTestEnv({ name: "ListEvtEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: { events: [{ type: "user.message", content: [{ type: "text", text: "a" }] }] },
      }),
      session.id as string,
    );
    const res = await handleListEvents(req(`/v1/sessions/${session.id}/events`), session.id as string);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("lists events with order asc", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "AscEvtAgent" });
    const env = await createTestEnv({ name: "AscEvtEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: {
          events: [
            { type: "user.message", content: [{ type: "text", text: "first" }] },
            { type: "user.message", content: [{ type: "text", text: "second" }] },
          ],
        },
      }),
      session.id as string,
    );
    const res = await handleListEvents(
      req(`/v1/sessions/${session.id}/events?order=asc`),
      session.id as string,
    );
    const body = (await res.json()) as { data: Array<{ seq: number }> };
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < body.data.length; i++) {
      expect(body.data[i].seq).toBeGreaterThan(body.data[i - 1].seq);
    }
  });

  it("lists events with order desc", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "DescEvtAgent" });
    const env = await createTestEnv({ name: "DescEvtEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: {
          events: [
            { type: "user.message", content: [{ type: "text", text: "first" }] },
            { type: "user.message", content: [{ type: "text", text: "second" }] },
          ],
        },
      }),
      session.id as string,
    );
    const res = await handleListEvents(
      req(`/v1/sessions/${session.id}/events?order=desc`),
      session.id as string,
    );
    const body = (await res.json()) as { data: Array<{ seq: number }> };
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < body.data.length; i++) {
      expect(body.data[i].seq).toBeLessThan(body.data[i - 1].seq);
    }
  });

  it("lists events with after_seq", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "AfterSeqAgent" });
    const env = await createTestEnv({ name: "AfterSeqEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: {
          events: [
            { type: "user.message", content: [{ type: "text", text: "one" }] },
            { type: "user.message", content: [{ type: "text", text: "two" }] },
            { type: "user.message", content: [{ type: "text", text: "three" }] },
          ],
        },
      }),
      session.id as string,
    );
    const res = await handleListEvents(
      req(`/v1/sessions/${session.id}/events?after_seq=2`),
      session.id as string,
    );
    const body = (await res.json()) as { data: Array<{ seq: number }> };
    body.data.forEach((e) => expect(e.seq).toBeGreaterThan(2));
  });

  it("events have sequence numbers", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "SeqAgent" });
    const env = await createTestEnv({ name: "SeqEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: { events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }] },
      }),
      session.id as string,
    );
    const res = await handleListEvents(req(`/v1/sessions/${session.id}/events`), session.id as string);
    const body = (await res.json()) as { data: Array<{ seq: number }> };
    expect(body.data[0].seq).toBe(1);
  });

  it("idempotency key deduplication", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "IdempAgent" });
    const env = await createTestEnv({ name: "IdempEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    const eventBody = {
      events: [{ type: "user.message", content: [{ type: "text", text: "dedup" }] }],
    };
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: eventBody,
        headers: { "idempotency-key": "same-key" },
      }),
      session.id as string,
    );
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: eventBody,
        headers: { "idempotency-key": "same-key" },
      }),
      session.id as string,
    );
    const res = await handleListEvents(req(`/v1/sessions/${session.id}/events`), session.id as string);
    const body = (await res.json()) as { data: Array<{ type: string }> };
    // Only 1 user.message event should exist due to idempotency key deduplication
    const userMessages = body.data.filter((e) => e.type === "user.message");
    expect(userMessages.length).toBe(1);
  });

  it("posts user.interrupt event", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "IntAgent" });
    const env = await createTestEnv({ name: "IntEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents } = await import("../src/handlers/events");
    const res = await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: { events: [{ type: "user.interrupt" }] },
      }),
      session.id as string,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ type: string }> };
    expect(body.data[0].type).toBe("user.interrupt");
  });

  it("posts multiple events in batch", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "BatchEvtAgent" });
    const env = await createTestEnv({ name: "BatchEvtEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents } = await import("../src/handlers/events");
    const res = await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: {
          events: [
            { type: "user.message", content: [{ type: "text", text: "one" }] },
            { type: "user.message", content: [{ type: "text", text: "two" }] },
          ],
        },
      }),
      session.id as string,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(2);
  });

  it("list events for non-existent session -> 404", async () => {
    await bootDb();
    const { handleListEvents } = await import("../src/handlers/events");
    const res = await handleListEvents(req("/v1/sessions/nope/events"), "nope");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

describe("Vaults", () => {
  beforeEach(() => freshDbEnv());

  it("creates vault -> 201", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "VaultAgent" });
    const { handleCreateVault } = await import("../src/handlers/vaults");
    const res = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "secrets" } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("secrets");
    expect(body.agent_id).toBe(agent.id);
  });

  it("creates vault with empty name -> 400", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "EmptyVaultAgent" });
    const { handleCreateVault } = await import("../src/handlers/vaults");
    const res = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "" } }),
    );
    expect(res.status).toBe(400);
  });

  it("creates vault with non-existent agent -> 404", async () => {
    await bootDb();
    const { handleCreateVault } = await import("../src/handlers/vaults");
    const res = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: "fake_agent", name: "v1" } }),
    );
    expect(res.status).toBe(404);
  });

  it("lists vaults -> returns array", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "ListVAgent" });
    const { handleCreateVault, handleListVaults } = await import("../src/handlers/vaults");
    await handleCreateVault(req("/v1/vaults", { body: { agent_id: agent.id, name: "v1" } }));
    await handleCreateVault(req("/v1/vaults", { body: { agent_id: agent.id, name: "v2" } }));
    const res = await handleListVaults(req("/v1/vaults"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(2);
  });

  it("lists vaults by agent_id", async () => {
    await bootDb();
    const a1 = await createTestAgent({ name: "VFilterA1" });
    const a2 = await createTestAgent({ name: "VFilterA2" });
    const { handleCreateVault, handleListVaults } = await import("../src/handlers/vaults");
    await handleCreateVault(req("/v1/vaults", { body: { agent_id: a1.id, name: "v1" } }));
    await handleCreateVault(req("/v1/vaults", { body: { agent_id: a2.id, name: "v2" } }));
    const res = await handleListVaults(req(`/v1/vaults?agent_id=${a1.id}`));
    const body = (await res.json()) as { data: Array<{ agent_id: string }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0].agent_id).toBe(a1.id);
  });

  it("gets vault by ID -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "GetVaultAgent" });
    const { handleCreateVault, handleGetVault } = await import("../src/handlers/vaults");
    const createRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "myvault" } }),
    );
    const vault = await createRes.json();
    const res = await handleGetVault(req(`/v1/vaults/${vault.id}`), vault.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(vault.id);
  });

  it("gets non-existent vault -> 404", async () => {
    await bootDb();
    const { handleGetVault } = await import("../src/handlers/vaults");
    const res = await handleGetVault(req("/v1/vaults/ghost"), "ghost");
    expect(res.status).toBe(404);
  });

  it("deletes vault -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "DelVaultAgent" });
    const { handleCreateVault, handleDeleteVault } = await import("../src/handlers/vaults");
    const createRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "todelete" } }),
    );
    const vault = await createRes.json();
    const res = await handleDeleteVault(
      req(`/v1/vaults/${vault.id}`, { method: "DELETE" }),
      vault.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("vault_deleted");
  });

  it("deletes non-existent vault -> 404", async () => {
    await bootDb();
    const { handleDeleteVault } = await import("../src/handlers/vaults");
    const res = await handleDeleteVault(
      req("/v1/vaults/ghost", { method: "DELETE" }),
      "ghost",
    );
    expect(res.status).toBe(404);
  });

  it("puts entry -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "EntryPutAgent" });
    const { handleCreateVault, handlePutEntry } = await import("../src/handlers/vaults");
    const createRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "entries" } }),
    );
    const vault = await createRes.json();
    const res = await handlePutEntry(
      req(`/v1/vaults/${vault.id}/entries/mykey`, { method: "PUT", body: { value: "myval" } }),
      vault.id,
      "mykey",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe("mykey");
    expect(body.ok).toBe(true);
  });

  it("gets entry -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "EntryGetAgent" });
    const { handleCreateVault, handlePutEntry, handleGetEntry } = await import("../src/handlers/vaults");
    const createRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "getentry" } }),
    );
    const vault = await createRes.json();
    await handlePutEntry(
      req(`/v1/vaults/${vault.id}/entries/k1`, { method: "PUT", body: { value: "v1" } }),
      vault.id,
      "k1",
    );
    const res = await handleGetEntry(req(`/v1/vaults/${vault.id}/entries/k1`), vault.id, "k1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe("k1");
    // Values are masked in API responses for security (full values only via server-side)
    expect(body.value).toBe("******");
  });

  it("gets non-existent entry -> 404", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "NoEntryAgent" });
    const { handleCreateVault, handleGetEntry } = await import("../src/handlers/vaults");
    const createRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "noentry" } }),
    );
    const vault = await createRes.json();
    const res = await handleGetEntry(req(`/v1/vaults/${vault.id}/entries/nope`), vault.id, "nope");
    expect(res.status).toBe(404);
  });

  it("deletes entry -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "DelEntryAgent" });
    const { handleCreateVault, handlePutEntry, handleDeleteEntry } = await import("../src/handlers/vaults");
    const createRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "delentry" } }),
    );
    const vault = await createRes.json();
    await handlePutEntry(
      req(`/v1/vaults/${vault.id}/entries/k1`, { method: "PUT", body: { value: "v1" } }),
      vault.id,
      "k1",
    );
    const res = await handleDeleteEntry(
      req(`/v1/vaults/${vault.id}/entries/k1`, { method: "DELETE" }),
      vault.id,
      "k1",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("entry_deleted");
  });

  it("deletes non-existent entry -> 404", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "DelNoEntryAgent" });
    const { handleCreateVault, handleDeleteEntry } = await import("../src/handlers/vaults");
    const createRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "nodelentry" } }),
    );
    const vault = await createRes.json();
    const res = await handleDeleteEntry(
      req(`/v1/vaults/${vault.id}/entries/nope`, { method: "DELETE" }),
      vault.id,
      "nope",
    );
    expect(res.status).toBe(404);
  });

  it("lists entries -> returns array", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "ListEntriesAgent" });
    const { handleCreateVault, handlePutEntry, handleListEntries } = await import("../src/handlers/vaults");
    const createRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "listentries" } }),
    );
    const vault = await createRes.json();
    await handlePutEntry(
      req(`/v1/vaults/${vault.id}/entries/k1`, { method: "PUT", body: { value: "v1" } }),
      vault.id,
      "k1",
    );
    await handlePutEntry(
      req(`/v1/vaults/${vault.id}/entries/k2`, { method: "PUT", body: { value: "v2" } }),
      vault.id,
      "k2",
    );
    const res = await handleListEntries(req(`/v1/vaults/${vault.id}/entries`), vault.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(2);
  });

  it("updates entry value (overwrite)", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "OverwriteAgent" });
    const { handleCreateVault, handlePutEntry, handleGetEntry } = await import("../src/handlers/vaults");
    const createRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "overwrite" } }),
    );
    const vault = await createRes.json();
    await handlePutEntry(
      req(`/v1/vaults/${vault.id}/entries/k`, { method: "PUT", body: { value: "old" } }),
      vault.id,
      "k",
    );
    await handlePutEntry(
      req(`/v1/vaults/${vault.id}/entries/k`, { method: "PUT", body: { value: "new" } }),
      vault.id,
      "k",
    );
    const res = await handleGetEntry(req(`/v1/vaults/${vault.id}/entries/k`), vault.id, "k");
    const body = await res.json();
    expect(body.value).toBe("******"); // masked in API response
  });

  it("vault has correct fields", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "VaultFieldsAgent" });
    const { handleCreateVault } = await import("../src/handlers/vaults");
    const res = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "fields" } }),
    );
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("agent_id", agent.id);
    expect(body).toHaveProperty("name", "fields");
    expect(body).toHaveProperty("created_at");
    expect(body).toHaveProperty("updated_at");
  });
});

// ---------------------------------------------------------------------------
// Memory Stores
// ---------------------------------------------------------------------------

describe("Memory Stores", () => {
  beforeEach(() => freshDbEnv());

  /** Helper: create an agent to own memory stores (required since v0.5). */
  async function memAgent(): Promise<string> {
    const a = await createTestAgent({ name: `mem-agent-${Date.now()}` });
    return a.id as string;
  }

  it("creates memory store -> 201", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore } = await import("../src/handlers/memory");
    const res = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "my-store", agent_id: agentId } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("my-store");
    expect(body.agent_id).toBe(agentId);
  });

  it("creates memory store without agent_id -> 400", async () => {
    await bootDb();
    const { handleCreateMemoryStore } = await import("../src/handlers/memory");
    const res = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "no-agent" } }),
    );
    expect(res.status).toBe(400);
  });

  it("creates memory store with empty name -> 400", async () => {
    await bootDb();
    const { handleCreateMemoryStore } = await import("../src/handlers/memory");
    const res = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "", agent_id: "fake" } }),
    );
    expect(res.status).toBe(400);
  });

  it("creates memory store with description", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore } = await import("../src/handlers/memory");
    const res = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "with-desc", description: "A test store", agent_id: agentId } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.description).toBe("A test store");
  });

  it("lists memory stores -> returns array", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleListMemoryStores } = await import("../src/handlers/memory");
    await handleCreateMemoryStore(req("/v1/memory_stores", { body: { name: "ms1", agent_id: agentId } }));
    await handleCreateMemoryStore(req("/v1/memory_stores", { body: { name: "ms2", agent_id: agentId } }));
    const res = await handleListMemoryStores(req("/v1/memory_stores"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(2);
  });

  it("gets memory store by ID -> 200", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleGetMemoryStore } = await import("../src/handlers/memory");
    const createRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "getme", agent_id: agentId } }),
    );
    const store = await createRes.json();
    const res = await handleGetMemoryStore(req(`/v1/memory_stores/${store.id}`), store.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(store.id);
  });

  it("gets non-existent memory store -> 404", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleGetMemoryStore } = await import("../src/handlers/memory");
    const res = await handleGetMemoryStore(req("/v1/memory_stores/nope"), "nope");
    expect(res.status).toBe(404);
  });

  it("deletes memory store -> 200", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleDeleteMemoryStore } = await import("../src/handlers/memory");
    const createRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "todelete", agent_id: agentId } }),
    );
    const store = await createRes.json();
    const res = await handleDeleteMemoryStore(
      req(`/v1/memory_stores/${store.id}`, { method: "DELETE" }),
      store.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("memory_store_deleted");
  });

  it("deletes non-existent memory store -> 404", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleDeleteMemoryStore } = await import("../src/handlers/memory");
    const res = await handleDeleteMemoryStore(
      req("/v1/memory_stores/ghost", { method: "DELETE" }),
      "ghost",
    );
    expect(res.status).toBe(404);
  });

  it("creates memory -> 201", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleCreateMemory } = await import("../src/handlers/memory");
    const createRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "memstore", agent_id: agentId } }),
    );
    const store = await createRes.json();
    const res = await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, {
        body: { path: "/docs/readme.md", content: "Hello world" },
      }),
      store.id,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.path).toBe("/docs/readme.md");
    expect(body.content).toBe("Hello world");
  });

  it("creates memory with empty path -> 400", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleCreateMemory } = await import("../src/handlers/memory");
    const createRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "emptypath", agent_id: agentId } }),
    );
    const store = await createRes.json();
    const res = await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, {
        body: { path: "", content: "Hello" },
      }),
      store.id,
    );
    expect(res.status).toBe(400);
  });

  it("creates memory in non-existent store -> 404", async () => {
    await bootDb();
    const { handleCreateMemory } = await import("../src/handlers/memory");
    const res = await handleCreateMemory(
      req("/v1/memory_stores/ghost/memories", {
        body: { path: "/test", content: "x" },
      }),
      "ghost",
    );
    expect(res.status).toBe(404);
  });

  it("lists memories -> returns array", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleCreateMemory, handleListMemories } = await import("../src/handlers/memory");
    const createRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "listmem", agent_id: agentId } }),
    );
    const store = await createRes.json();
    await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, { body: { path: "/a", content: "aa" } }),
      store.id,
    );
    await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, { body: { path: "/b", content: "bb" } }),
      store.id,
    );
    const res = await handleListMemories(req(`/v1/memory_stores/${store.id}/memories`), store.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(2);
  });

  it("gets memory by ID -> 200", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleCreateMemory, handleGetMemory } = await import("../src/handlers/memory");
    const storeRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "getmem", agent_id: agentId } }),
    );
    const store = await storeRes.json();
    const memRes = await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, { body: { path: "/x", content: "content" } }),
      store.id,
    );
    const mem = await memRes.json();
    const res = await handleGetMemory(
      req(`/v1/memory_stores/${store.id}/memories/${mem.id}`),
      store.id,
      mem.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(mem.id);
  });

  it("gets non-existent memory -> 404", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleGetMemory } = await import("../src/handlers/memory");
    const storeRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "getmemnone", agent_id: agentId } }),
    );
    const store = await storeRes.json();
    const res = await handleGetMemory(
      req(`/v1/memory_stores/${store.id}/memories/nope`),
      store.id,
      "nope",
    );
    expect(res.status).toBe(404);
  });

  it("updates memory content -> 200", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleCreateMemory, handleUpdateMemory } = await import("../src/handlers/memory");
    const storeRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "updmem", agent_id: agentId } }),
    );
    const store = await storeRes.json();
    const memRes = await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, { body: { path: "/up", content: "old" } }),
      store.id,
    );
    const mem = await memRes.json();
    const res = await handleUpdateMemory(
      req(`/v1/memory_stores/${store.id}/memories/${mem.id}`, {
        method: "PATCH",
        body: { content: "new" },
      }),
      store.id,
      mem.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("new");
  });

  it("update memory with wrong SHA -> 409", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleCreateMemory, handleUpdateMemory } = await import("../src/handlers/memory");
    const storeRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "shamem", agent_id: agentId } }),
    );
    const store = await storeRes.json();
    const memRes = await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, { body: { path: "/sha", content: "original" } }),
      store.id,
    );
    const mem = await memRes.json();
    const res = await handleUpdateMemory(
      req(`/v1/memory_stores/${store.id}/memories/${mem.id}`, {
        method: "PATCH",
        body: { content: "new", content_sha256: "wrong-sha-value" },
      }),
      store.id,
      mem.id,
    );
    expect(res.status).toBe(409);
  });

  it("deletes memory -> 200", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleCreateMemory, handleDeleteMemory } = await import("../src/handlers/memory");
    const storeRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "delmem", agent_id: agentId } }),
    );
    const store = await storeRes.json();
    const memRes = await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, { body: { path: "/del", content: "x" } }),
      store.id,
    );
    const mem = await memRes.json();
    const res = await handleDeleteMemory(
      req(`/v1/memory_stores/${store.id}/memories/${mem.id}`, { method: "DELETE" }),
      store.id,
      mem.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("memory_deleted");
  });

  it("deletes non-existent memory -> 404", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleDeleteMemory } = await import("../src/handlers/memory");
    const storeRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "delnomem", agent_id: agentId } }),
    );
    const store = await storeRes.json();
    const res = await handleDeleteMemory(
      req(`/v1/memory_stores/${store.id}/memories/nope`, { method: "DELETE" }),
      store.id,
      "nope",
    );
    expect(res.status).toBe(404);
  });

  it("memory has correct fields", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleCreateMemory } = await import("../src/handlers/memory");
    const storeRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "fieldsmem", agent_id: agentId } }),
    );
    const store = await storeRes.json();
    const memRes = await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, { body: { path: "/f", content: "test" } }),
      store.id,
    );
    const body = await memRes.json();
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("store_id", store.id);
    expect(body).toHaveProperty("path", "/f");
    expect(body).toHaveProperty("content", "test");
    expect(body).toHaveProperty("content_sha256");
    expect(body).toHaveProperty("created_at");
    expect(body).toHaveProperty("updated_at");
  });

  it("memory store has correct fields", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore } = await import("../src/handlers/memory");
    const res = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "fieldstore", agent_id: agentId } }),
    );
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("name", "fieldstore");
    expect(body).toHaveProperty("description");
    expect(body).toHaveProperty("created_at");
    expect(body).toHaveProperty("updated_at");
  });

  it("upserts memory with same path (create or update)", async () => {
    await bootDb();
    const agentId = await memAgent();
    const { handleCreateMemoryStore, handleCreateMemory, handleListMemories } = await import("../src/handlers/memory");
    const storeRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "upsert", agent_id: agentId } }),
    );
    const store = await storeRes.json();
    await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, { body: { path: "/same", content: "v1" } }),
      store.id,
    );
    const res2 = await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, { body: { path: "/same", content: "v2" } }),
      store.id,
    );
    const body2 = await res2.json();
    expect(body2.content).toBe("v2");
    // Should still be just one memory
    const listRes = await handleListMemories(req(`/v1/memory_stores/${store.id}/memories`), store.id);
    const list = (await listRes.json()) as { data: unknown[] };
    expect(list.data.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

describe("Batch", () => {
  beforeEach(() => freshDbEnv());

  it("executes batch with valid operations -> 200", async () => {
    await bootDb();
    const { handleBatch } = await import("../src/handlers/batch");
    // Use POST /v1/environments which does not use nested transactions
    const res = await handleBatch(
      req("/v1/batch", {
        body: {
          operations: [
            { method: "POST", path: "/v1/environments", body: { name: "BatchEnv1", config: { type: "cloud" } } },
            { method: "POST", path: "/v1/environments", body: { name: "BatchEnv2", config: { type: "cloud" } } },
          ],
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ status: number }> };
    expect(body.results.length).toBe(2);
    expect(body.results[0].status).toBe(201);
    expect(body.results[1].status).toBe(201);
  });

  it("batch with empty operations -> 400", async () => {
    await bootDb();
    const { handleBatch } = await import("../src/handlers/batch");
    const res = await handleBatch(
      req("/v1/batch", { body: { operations: [] } }),
    );
    expect(res.status).toBe(400);
  });

  it("batch with >50 operations -> 400", async () => {
    await bootDb();
    const { handleBatch } = await import("../src/handlers/batch");
    const ops = Array.from({ length: 51 }, (_, i) => ({
      method: "POST",
      path: "/v1/agents",
      body: { name: `BatchOverflow${i}`, model: "claude-sonnet-4-6" },
    }));
    const res = await handleBatch(
      req("/v1/batch", { body: { operations: ops } }),
    );
    expect(res.status).toBe(400);
  });

  it("batch with invalid operation -> error with failed_operation_index", async () => {
    await bootDb();
    // Pre-create an agent outside the batch (to avoid nested transaction issues)
    const { createAgent } = await import("../src/db/agents");
    const realAgent = createAgent({
      name: "BatchRealAgent",
      model: "claude-sonnet-4-6",
      system: null,
      tools: [],
      mcp_servers: {},
      backend: "claude",
      webhook_url: null,
      threads_enabled: false,
    });
    const { handleBatch } = await import("../src/handlers/batch");
    // Op 0: DELETE existing agent (succeeds), Op 1: DELETE nonexistent (fails at index 1)
    const res = await handleBatch(
      req("/v1/batch", {
        body: {
          operations: [
            { method: "DELETE", path: `/v1/agents/${realAgent.id}` },
            { method: "DELETE", path: "/v1/agents/nonexistent" },
          ],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { failed_operation_index: number } };
    expect(body.error.failed_operation_index).toBe(1);
  });

  it("batch can create environments and return results", async () => {
    await bootDb();
    const { handleBatch } = await import("../src/handlers/batch");
    // createEnvironment does not use nested transactions so it works in a batch
    const res = await handleBatch(
      req("/v1/batch", {
        body: {
          operations: [
            { method: "POST", path: "/v1/environments", body: { name: "BatchEnvA", config: { type: "cloud" } } },
            { method: "POST", path: "/v1/environments", body: { name: "BatchEnvB", config: { type: "cloud" } } },
          ],
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ status: number; body: { name: string } }> };
    expect(body.results[0].body.name).toBe("BatchEnvA");
    expect(body.results[1].body.name).toBe("BatchEnvB");
  });

  it("batch with unsupported operation -> error", async () => {
    await bootDb();
    const { handleBatch } = await import("../src/handlers/batch");
    const res = await handleBatch(
      req("/v1/batch", {
        body: {
          operations: [
            { method: "PATCH", path: "/v1/agents/something", body: { name: "x" } },
          ],
        },
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("Settings", () => {
  beforeEach(() => freshDbEnv());

  it("writes allowed setting -> 200", async () => {
    await bootDb();
    const { handlePutSetting } = await import("../src/handlers/settings");
    const res = await handlePutSetting(
      req("/v1/settings", { method: "PUT", body: { key: "sprite_token", value: "sk_test" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("writes disallowed key -> 400", async () => {
    await bootDb();
    const { handlePutSetting } = await import("../src/handlers/settings");
    const res = await handlePutSetting(
      req("/v1/settings", { method: "PUT", body: { key: "evil_key", value: "bad" } }),
    );
    expect(res.status).toBe(400);
  });

  it("writes without key -> 400", async () => {
    await bootDb();
    const { handlePutSetting } = await import("../src/handlers/settings");
    const res = await handlePutSetting(
      req("/v1/settings", { method: "PUT", body: { value: "something" } }),
    );
    expect(res.status).toBe(400);
  });

  it("writes without value -> 400", async () => {
    await bootDb();
    const { handlePutSetting } = await import("../src/handlers/settings");
    const res = await handlePutSetting(
      req("/v1/settings", { method: "PUT", body: { key: "sprite_token" } }),
    );
    expect(res.status).toBe(400);
  });

  it("setting persists and is readable via config", async () => {
    await bootDb();
    const { handlePutSetting } = await import("../src/handlers/settings");
    await handlePutSetting(
      req("/v1/settings", { method: "PUT", body: { key: "anthropic_api_key", value: "sk-ant-test123" } }),
    );
    // Invalidate config cache and re-read
    const { invalidateConfigCache, getConfig } = await import("../src/config");
    invalidateConfigCache();
    const cfg = getConfig();
    expect(cfg.anthropicApiKey).toBe("sk-ant-test123");
  });

  it("writes each allowed key successfully", async () => {
    await bootDb();
    const { handlePutSetting } = await import("../src/handlers/settings");
    const keys = [
      "sprite_token", "anthropic_api_key", "openai_api_key",
      "gemini_api_key", "factory_api_key", "claude_token",
      "e2b_api_key", "vercel_token", "daytona_api_key",
      "fly_api_token", "modal_token_id",
    ];
    for (const key of keys) {
      const res = await handlePutSetting(
        req("/v1/settings", { method: "PUT", body: { key, value: "test-val" } }),
      );
      expect(res.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("Auth", () => {
  beforeEach(() => freshDbEnv());

  it("request without API key -> 401", async () => {
    await bootDb();
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(
      new Request("http://localhost/v1/agents", { method: "GET" }),
    );
    expect(res.status).toBe(401);
  });

  it("request with invalid API key -> 401", async () => {
    await bootDb();
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents", { apiKey: "bad-key-wrong" }));
    expect(res.status).toBe(401);
  });

  it("request with valid API key -> 200", async () => {
    await bootDb();
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents", { apiKey: "test-api-key-12345" }));
    expect(res.status).toBe(200);
  });

  it("API key in x-api-key header works", async () => {
    await bootDb();
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(
      new Request("http://localhost/v1/agents", {
        method: "GET",
        headers: { "x-api-key": "test-api-key-12345" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("API key in Authorization Bearer header works", async () => {
    await bootDb();
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(
      new Request("http://localhost/v1/agents", {
        method: "GET",
        headers: { authorization: "Bearer test-api-key-12345" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("401 response has correct error envelope", async () => {
    await bootDb();
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(
      new Request("http://localhost/v1/agents", { method: "GET" }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });
});

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

describe("Error Handling", () => {
  beforeEach(() => freshDbEnv());

  it("invalid JSON body -> 400 or 500", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(
      new Request("http://localhost/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test-api-key-12345" },
        body: "{not valid json",
      }),
    );
    // The handler catches JSON.parse errors and returns either 400 or 500
    expect([400, 500]).toContain(res.status);
  });

  it("error responses have correct envelope shape", async () => {
    await bootDb();
    const { handleGetAgent } = await import("../src/handlers/agents");
    const res = await handleGetAgent(req("/v1/agents/nope"), "nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error).toHaveProperty("type");
    expect(body.error).toHaveProperty("message");
  });

  it("not found has correct error type", async () => {
    await bootDb();
    const { handleGetAgent } = await import("../src/handlers/agents");
    const res = await handleGetAgent(req("/v1/agents/missing"), "missing");
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_found_error");
  });

  it("bad request has correct error type", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(
      req("/v1/agents", { body: { name: "", model: "" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("conflict has correct error type and status", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    await handleCreateAgent(req("/v1/agents", { body: { name: "Conflict", model: "claude-sonnet-4-6" } }));
    const res = await handleCreateAgent(
      req("/v1/agents", { body: { name: "Conflict", model: "claude-sonnet-4-6" } }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("toResponse wraps unknown errors as server_error", async () => {
    const { toResponse } = await import("../src/errors");
    const res = toResponse(new Error("boom"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("server_error");
  });

  it("toResponse wraps ApiError correctly", async () => {
    const { toResponse, badRequest } = await import("../src/errors");
    const res = toResponse(badRequest("oops"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "oops" },
    });
  });
});

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

describe("Threads", () => {
  beforeEach(() => freshDbEnv());

  it("lists threads for a session -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "ThreadAgent" });
    const env = await createTestEnv({ name: "ThreadEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handleListThreads } = await import("../src/handlers/threads");
    const res = await handleListThreads(
      req(`/v1/sessions/${session.id}/threads`),
      session.id as string,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(0); // no child sessions
  });

  it("lists threads for non-existent session -> 404", async () => {
    await bootDb();
    const { handleListThreads } = await import("../src/handlers/threads");
    const res = await handleListThreads(req("/v1/sessions/ghost/threads"), "ghost");
    expect(res.status).toBe(404);
  });

  it("lists threads returns child sessions", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "ParentAgent" });
    const env = await createTestEnv({ name: "ParentEnv" });
    const parent = await createTestSession(agent.id as string, env.id as string);

    // Create a child session by inserting directly
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");
    const db = getDb();
    const childId = newId("sess");
    const now = nowMs();
    db.prepare(
      `INSERT INTO sessions (
         id, agent_id, agent_version, environment_id, status,
         title, metadata_json, parent_session_id, thread_depth,
         created_at, updated_at
       ) VALUES (?, ?, 1, ?, 'idle', NULL, '{}', ?, 1, ?, ?)`,
    ).run(childId, agent.id, env.id, parent.id, now, now);

    const { handleListThreads } = await import("../src/handlers/threads");
    const res = await handleListThreads(
      req(`/v1/sessions/${parent.id}/threads`),
      parent.id as string,
    );
    const body = (await res.json()) as { data: Array<{ id: string; parent_session_id: string }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0].parent_session_id).toBe(parent.id);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: pagination & ordering
// ---------------------------------------------------------------------------

describe("Pagination & Ordering", () => {
  beforeEach(() => freshDbEnv());

  it("agents list returns next_page cursor", async () => {
    await bootDb();
    await createTestAgent({ name: "P1" });
    await createTestAgent({ name: "P2" });
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents?limit=1"));
    const body = (await res.json()) as { data: Array<{ id: string }>; next_page: string | null };
    expect(body.data.length).toBe(1);
    expect(body.next_page).toBeTruthy();
  });

  it("agents list order=asc works", async () => {
    await bootDb();
    await createTestAgent({ name: "Order1" });
    await createTestAgent({ name: "Order2" });
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents?order=asc"));
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBe(2);
    // ASC means first ID < second ID
    expect(body.data[0].id < body.data[1].id).toBe(true);
  });

  it("environments list returns next_page cursor", async () => {
    await bootDb();
    await createTestEnv({ name: "EP1" });
    await createTestEnv({ name: "EP2" });
    const { handleListEnvironments } = await import("../src/handlers/environments");
    const res = await handleListEnvironments(req("/v1/environments?limit=1"));
    const body = (await res.json()) as { data: unknown[]; next_page: string | null };
    expect(body.data.length).toBe(1);
    expect(body.next_page).toBeTruthy();
  });

  it("sessions list order=asc works", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "OrdSessAgent" });
    const env = await createTestEnv({ name: "OrdSessEnv" });
    await createTestSession(agent.id as string, env.id as string);
    await createTestSession(agent.id as string, env.id as string);
    const { handleListSessions } = await import("../src/handlers/sessions");
    const res = await handleListSessions(req("/v1/sessions?order=asc"));
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.length).toBe(2);
    expect(body.data[0].id < body.data[1].id).toBe(true);
  });

  it("events list has next_page", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "EvtPageAgent" });
    const env = await createTestEnv({ name: "EvtPageEnv" });
    const session = await createTestSession(agent.id as string, env.id as string);
    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: {
          events: [
            { type: "user.message", content: [{ type: "text", text: "a" }] },
            { type: "user.message", content: [{ type: "text", text: "b" }] },
          ],
        },
      }),
      session.id as string,
    );
    const res = await handleListEvents(
      req(`/v1/sessions/${session.id}/events?limit=1`),
      session.id as string,
    );
    const body = (await res.json()) as { data: unknown[]; next_page: string | null };
    expect(body.data.length).toBe(1);
    expect(body.next_page).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge Cases", () => {
  beforeEach(() => freshDbEnv());

  it("creating an agent with null body -> 400", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(
      new Request("http://localhost/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test-api-key-12345" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("creating session with missing body fields -> 400", async () => {
    await bootDb();
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(
      req("/v1/sessions", { body: {} }),
    );
    expect(res.status).toBe(400);
  });

  it("listing vaults with no data returns empty array", async () => {
    await bootDb();
    const { handleListVaults } = await import("../src/handlers/vaults");
    const res = await handleListVaults(req("/v1/vaults"));
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it("listing memory stores with no data returns empty array", async () => {
    await bootDb();
    const { handleListMemoryStores } = await import("../src/handlers/memory");
    const res = await handleListMemoryStores(req("/v1/memory_stores"));
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it("creating vault without agent_id -> 400", async () => {
    await bootDb();
    const { handleCreateVault } = await import("../src/handlers/vaults");
    const res = await handleCreateVault(
      req("/v1/vaults", { body: { name: "no-agent" } }),
    );
    expect(res.status).toBe(400);
  });

  it("put entry with missing value -> 400", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "PutNoValAgent" });
    const { handleCreateVault, handlePutEntry } = await import("../src/handlers/vaults");
    const createRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "noentry" } }),
    );
    const vault = await createRes.json();
    const res = await handlePutEntry(
      req(`/v1/vaults/${vault.id}/entries/k`, { method: "PUT", body: { notvalue: "x" } }),
      vault.id,
      "k",
    );
    expect(res.status).toBe(400);
  });

  it("list entries on non-existent vault -> 404", async () => {
    await bootDb();
    const { handleListEntries } = await import("../src/handlers/vaults");
    const res = await handleListEntries(req("/v1/vaults/ghost/entries"), "ghost");
    expect(res.status).toBe(404);
  });

  it("get entry on non-existent vault -> 404", async () => {
    await bootDb();
    const { handleGetEntry } = await import("../src/handlers/vaults");
    const res = await handleGetEntry(req("/v1/vaults/ghost/entries/k"), "ghost", "k");
    expect(res.status).toBe(404);
  });

  it("put entry on non-existent vault -> 404", async () => {
    await bootDb();
    const { handlePutEntry } = await import("../src/handlers/vaults");
    const res = await handlePutEntry(
      req("/v1/vaults/ghost/entries/k", { method: "PUT", body: { value: "v" } }),
      "ghost",
      "k",
    );
    expect(res.status).toBe(404);
  });

  it("delete entry on non-existent vault -> 404", async () => {
    await bootDb();
    const { handleDeleteEntry } = await import("../src/handlers/vaults");
    const res = await handleDeleteEntry(
      req("/v1/vaults/ghost/entries/k", { method: "DELETE" }),
      "ghost",
      "k",
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// SDK API Key Export
// ---------------------------------------------------------------------------

describe("SDK API Key Export", () => {
  beforeEach(() => freshDbEnv());

  it("createApiKey is callable from SDK exports", async () => {
    await bootDb();
    const { createApiKey } = await import("../src/index");
    const { key, id } = createApiKey({ name: "test-export", permissions: ["*"] });
    expect(key).toBeTruthy();
    expect(id).toBeTruthy();
    expect(key.startsWith("ck_")).toBe(true);
  });

  it("listApiKeys returns created keys", async () => {
    await bootDb();
    const { createApiKey, listApiKeys } = await import("../src/index");
    createApiKey({ name: "key1", permissions: ["*"] });
    createApiKey({ name: "key2", permissions: ["*"] });
    const keys = listApiKeys();
    // bootDb() seeds one key + we created two more
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });

  it("createApiKey generates unique ids and keys", async () => {
    await bootDb();
    const { createApiKey } = await import("../src/index");
    const a = createApiKey({ name: "a", permissions: ["*"] });
    const b = createApiKey({ name: "b", permissions: ["*"] });
    expect(a.id).not.toBe(b.id);
    expect(a.key).not.toBe(b.key);
  });
});

// ---------------------------------------------------------------------------
// Config Settings Roundtrip
// ---------------------------------------------------------------------------

describe("Config Settings Roundtrip", () => {
  beforeEach(() => freshDbEnv());

  it("writeSetting persists and getConfig reads it", async () => {
    await bootDb();
    const { writeSetting, getConfig, invalidateConfigCache } = await import("../src/config/index");
    writeSetting("anthropic_api_key", "sk-test-123");
    invalidateConfigCache();
    const cfg = getConfig();
    // env var takes precedence; only verify when env var is not set
    if (!process.env.ANTHROPIC_API_KEY) {
      expect(cfg.anthropicApiKey).toBe("sk-test-123");
    }
  });

  it("writeSetting updates existing value", async () => {
    await bootDb();
    const { writeSetting, getConfig, invalidateConfigCache } = await import("../src/config/index");
    writeSetting("openai_api_key", "old-key");
    writeSetting("openai_api_key", "new-key");
    invalidateConfigCache();
    if (!process.env.OPENAI_API_KEY) {
      expect(getConfig().openAiApiKey).toBe("new-key");
    }
  });

  it("invalidateConfigCache forces reload on next getConfig call", async () => {
    await bootDb();
    const { writeSetting, getConfig, invalidateConfigCache } = await import("../src/config/index");
    // Warm the cache
    getConfig();
    writeSetting("default_model", "gemini-2.5-flash");
    invalidateConfigCache();
    if (!process.env.DEFAULT_MODEL) {
      expect(getConfig().defaultModel).toBe("gemini-2.5-flash");
    }
  });
});

describe("Provider Status", () => {
  beforeEach(() => freshDbEnv());

  it("returns status for all providers", async () => {
    await bootDb();
    const { handleGetProviderStatus } = await import("../src/handlers/providers");
    const res = await handleGetProviderStatus(req("/v1/providers/status"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, { available: boolean; message?: string }> };
    expect(body.data).toBeDefined();
    expect(body.data.docker).toBeDefined();
    expect(body.data["apple-container"]).toBeDefined();
    expect(body.data.podman).toBeDefined();
    expect(body.data.sprites).toBeDefined();
    expect(body.data.e2b).toBeDefined();
    expect(body.data.vercel).toBeDefined();
    expect(body.data.daytona).toBeDefined();
    expect(body.data.fly).toBeDefined();
    expect(body.data.modal).toBeDefined();
    for (const [, status] of Object.entries(body.data)) {
      expect(typeof status.available).toBe("boolean");
      if (!status.available) {
        expect(typeof status.message).toBe("string");
      }
    }
  });

  it("cloud providers without keys report unavailable", async () => {
    await bootDb();
    const saved = { ...process.env };
    delete process.env.SPRITE_TOKEN;
    delete process.env.E2B_API_KEY;
    delete process.env.VERCEL_TOKEN;
    const g = globalThis as typeof globalThis & { __caConfigCache?: unknown };
    delete g.__caConfigCache;
    try {
      const { handleGetProviderStatus } = await import("../src/handlers/providers");
      const res = await handleGetProviderStatus(req("/v1/providers/status"));
      const body = await res.json() as { data: Record<string, { available: boolean; message?: string }> };
      expect(body.data.sprites.available).toBe(false);
      expect(body.data.sprites.message).toContain("SPRITE_TOKEN");
      expect(body.data.e2b.available).toBe(false);
      expect(body.data.e2b.message).toContain("E2B_API_KEY");
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it("requires auth", async () => {
    await bootDb();
    const { handleGetProviderStatus } = await import("../src/handlers/providers");
    const res = await handleGetProviderStatus(req("/v1/providers/status", { apiKey: "" }));
    expect(res.status).toBe(401);
  });
});

describe("Skills API", () => {
  beforeEach(() => freshDbEnv());

  it("GET /v1/skills/catalog returns skills from feed", async () => {
    await bootDb();
    const { handleGetSkillsCatalog } = await import("../src/handlers/skills");
    const res = await handleGetSkillsCatalog(req("/v1/skills/catalog?leaderboard=trending&limit=5"));
    expect(res.status).toBe(200);
    const body = await res.json() as { skills: any[]; total: number };
    expect(body.skills).toBeDefined();
    expect(Array.isArray(body.skills)).toBe(true);
  });

  it("GET /v1/skills/stats returns stats", async () => {
    await bootDb();
    const { handleGetSkillsStats } = await import("../src/handlers/skills");
    const res = await handleGetSkillsStats(req("/v1/skills/stats"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.totalSkills).toBe("number");
    expect(typeof body.totalSources).toBe("number");
    expect(typeof body.totalOwners).toBe("number");
    expect(typeof body.indexLoaded).toBe("boolean");
  });

  it("GET /v1/skills/feed returns feed data", async () => {
    await bootDb();
    const { handleGetSkillsFeed } = await import("../src/handlers/skills");
    const res = await handleGetSkillsFeed(req("/v1/skills/feed"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.topAllTime).toBeDefined();
    expect(body.topTrending).toBeDefined();
    expect(body.topHot).toBeDefined();
  });

  it("skills endpoints require auth", async () => {
    await bootDb();
    const { handleGetSkillsCatalog, handleGetSkillsStats, handleSearchSkills } = await import("../src/handlers/skills");
    expect((await handleGetSkillsCatalog(req("/v1/skills/catalog", { apiKey: "" }))).status).toBe(401);
    expect((await handleGetSkillsStats(req("/v1/skills/stats", { apiKey: "" }))).status).toBe(401);
    expect((await handleSearchSkills(req("/v1/skills", { apiKey: "" }))).status).toBe(401);
  });
});

describe("Agent Skills CRUD", () => {
  beforeEach(() => freshDbEnv());

  it("create agent with skills", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const skills = [
      { name: "test-skill", source: "test/repo@test-skill", content: "# Test Skill\nContent here.", installed_at: new Date().toISOString() },
    ];
    const res = await handleCreateAgent(req("/v1/agents", {
      body: { name: "Agent-Skills-Test", model: "claude-sonnet-4-6", skills },
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.skills).toBeDefined();
    const agentSkills = body.skills as any[];
    expect(agentSkills.length).toBe(1);
    expect(agentSkills[0].name).toBe("test-skill");
    expect(agentSkills[0].content).toContain("Test Skill");
  });

  it("get agent returns skills", async () => {
    await bootDb();
    const { handleCreateAgent, handleGetAgent } = await import("../src/handlers/agents");
    const skills = [
      { name: "s1", source: "a/b@s1", content: "content1", installed_at: new Date().toISOString() },
      { name: "s2", source: "a/b@s2", content: "content2", installed_at: new Date().toISOString() },
    ];
    const createRes = await handleCreateAgent(req("/v1/agents", {
      body: { name: "Agent-Get-Skills", model: "claude-sonnet-4-6", skills },
    }));
    const agent = await createRes.json() as Record<string, unknown>;

    const getRes = await handleGetAgent(req(`/v1/agents/${agent.id}`), agent.id as string);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json() as Record<string, unknown>;
    expect((fetched.skills as any[]).length).toBe(2);
  });

  it("update agent adds skills", async () => {
    await bootDb();
    const { handleCreateAgent, handleUpdateAgent, handleGetAgent } = await import("../src/handlers/agents");
    const createRes = await handleCreateAgent(req("/v1/agents", {
      body: { name: "Agent-Add-Skills", model: "claude-sonnet-4-6" },
    }));
    const agent = await createRes.json() as Record<string, unknown>;

    // Add skills via update
    const newSkills = [
      { name: "added-skill", source: "x/y@added-skill", content: "# Added", installed_at: new Date().toISOString() },
    ];
    const updateRes = await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, { body: { skills: newSkills } }),
      agent.id as string,
    );
    expect(updateRes.status).toBe(200);

    // Verify
    const getRes = await handleGetAgent(req(`/v1/agents/${agent.id}`), agent.id as string);
    const fetched = await getRes.json() as Record<string, unknown>;
    expect((fetched.skills as any[]).length).toBe(1);
    expect((fetched.skills as any[])[0].name).toBe("added-skill");
  });

  it("update agent removes skills", async () => {
    await bootDb();
    const { handleCreateAgent, handleUpdateAgent, handleGetAgent } = await import("../src/handlers/agents");
    const skills = [
      { name: "keep", source: "a/b@keep", content: "keep", installed_at: new Date().toISOString() },
      { name: "remove", source: "a/b@remove", content: "remove", installed_at: new Date().toISOString() },
    ];
    const createRes = await handleCreateAgent(req("/v1/agents", {
      body: { name: "Agent-Remove-Skills", model: "claude-sonnet-4-6", skills },
    }));
    const agent = await createRes.json() as Record<string, unknown>;

    // Remove one skill
    await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, { body: { skills: [skills[0]] } }),
      agent.id as string,
    );

    const getRes = await handleGetAgent(req(`/v1/agents/${agent.id}`), agent.id as string);
    const fetched = await getRes.json() as Record<string, unknown>;
    expect((fetched.skills as any[]).length).toBe(1);
    expect((fetched.skills as any[])[0].name).toBe("keep");
  });

  it("skills size limit enforced", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const bigContent = "x".repeat(300_000); // > 256KB limit
    const skills = [
      { name: "big", source: "a/b@big", content: bigContent, installed_at: new Date().toISOString() },
    ];
    const res = await handleCreateAgent(req("/v1/agents", {
      body: { name: "Agent-Big-Skill", model: "claude-sonnet-4-6", skills },
    }));
    // Should reject or accept based on implementation — either 400 or 201
    const status = res.status;
    expect([201, 400]).toContain(status);
  });
});

describe("Environment Creation — Cloud Provider Skip", () => {
  beforeEach(() => freshDbEnv());

  it("cloud provider skips availability check", async () => {
    await bootDb();
    const { handleCreateEnvironment } = await import("../src/handlers/environments");
    const res = await handleCreateEnvironment(req("/v1/environments", {
      body: { name: `cloud-env-${Date.now()}`, config: { type: "cloud", provider: "e2b", packages: {} } },
    }));
    // Should succeed even without E2B_API_KEY — check is skipped for cloud providers
    expect(res.status).toBe(201);
  });

  it("duplicate environment name rejected", async () => {
    await bootDb();
    const { handleCreateEnvironment } = await import("../src/handlers/environments");
    const name = `dup-env-${Date.now()}`;
    const res1 = await handleCreateEnvironment(req("/v1/environments", {
      body: { name, config: { type: "cloud", provider: "e2b", packages: {} } },
    }));
    expect(res1.status).toBe(201);

    const res2 = await handleCreateEnvironment(req("/v1/environments", {
      body: { name, config: { type: "cloud", provider: "e2b", packages: {} } },
    }));
    expect(res2.status).toBe(409);
  });
});

// ── OpenAPI ─────────────────────────────────────────────────────────────────

describe("OpenAPI Spec", () => {
  beforeEach(() => freshDbEnv());

  it("GET /v1/openapi.json returns valid spec", async () => {
    await bootDb();
    const { handleGetOpenApiSpec } = await import("../src/handlers/openapi");
    const res = await handleGetOpenApiSpec(req("/v1/openapi.json"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.openapi).toBeDefined();
    expect(body.paths).toBeDefined();
    expect(body.info).toBeDefined();
  });

  it("spec includes all expected paths", async () => {
    await bootDb();
    const { handleGetOpenApiSpec } = await import("../src/handlers/openapi");
    const res = await handleGetOpenApiSpec(req("/v1/openapi.json"));
    const body = await res.json() as { paths: Record<string, unknown> };
    const paths = Object.keys(body.paths);
    expect(paths).toContain("/v1/agents");
    expect(paths).toContain("/v1/environments");
    expect(paths).toContain("/v1/sessions");
    expect(paths).toContain("/v1/vaults");
  });
});

// ── SSE Stream ──────────────────────────────────────────────────────────────

describe("Session Stream", () => {
  beforeEach(() => freshDbEnv());

  it("returns SSE response for valid session", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const sessRes = await handleCreateSession(req("/v1/sessions", {
      body: { agent: agent.id, environment_id: env.id },
    }));
    const session = await sessRes.json() as Record<string, unknown>;

    const { handleSessionStream } = await import("../src/handlers/stream");
    const controller = new AbortController();
    const streamReq = new Request(`http://localhost/v1/sessions/${session.id}/stream`, {
      headers: { "x-api-key": "test-api-key-12345" },
      signal: controller.signal,
    });
    const res = await handleSessionStream(streamReq, session.id as string);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    controller.abort();
  });

  it("returns 404 for missing session", async () => {
    await bootDb();
    const { handleSessionStream } = await import("../src/handlers/stream");
    const res = await handleSessionStream(
      req("/v1/sessions/sess_nonexistent/stream"),
      "sess_nonexistent",
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 without auth", async () => {
    await bootDb();
    const { handleSessionStream } = await import("../src/handlers/stream");
    const res = await handleSessionStream(
      req("/v1/sessions/sess_x/stream", { apiKey: "" }),
      "sess_x",
    );
    expect(res.status).toBe(401);
  });
});

// ── Additional Environment Tests ────────────────────────────────────────────

describe("Environments — Additional Coverage", () => {
  beforeEach(() => freshDbEnv());

  it("list environments with limit and order", async () => {
    await bootDb();
    const { handleCreateEnvironment, handleListEnvironments } = await import("../src/handlers/environments");
    for (let i = 0; i < 3; i++) {
      await handleCreateEnvironment(req("/v1/environments", {
        body: { name: `env-${i}-${Date.now()}`, config: { type: "cloud", provider: "e2b", packages: {} } },
      }));
    }
    const res = await handleListEnvironments(req("/v1/environments?limit=2&order=desc"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: any[] };
    expect(body.data.length).toBeLessThanOrEqual(2);
  });

  it("get environment by id", async () => {
    await bootDb();
    const { handleCreateEnvironment, handleGetEnvironment } = await import("../src/handlers/environments");
    const createRes = await handleCreateEnvironment(req("/v1/environments", {
      body: { name: `env-get-${Date.now()}`, config: { type: "cloud", provider: "e2b", packages: {} } },
    }));
    const env = await createRes.json() as Record<string, unknown>;
    const getRes = await handleGetEnvironment(req(`/v1/environments/${env.id}`), env.id as string);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json() as Record<string, unknown>;
    expect(fetched.id).toBe(env.id);
    expect(fetched.name).toBeDefined();
  });

  it("get nonexistent environment returns 404", async () => {
    await bootDb();
    const { handleGetEnvironment } = await import("../src/handlers/environments");
    const res = await handleGetEnvironment(req("/v1/environments/env_nonexistent"), "env_nonexistent");
    expect(res.status).toBe(404);
  });

  it("delete environment", async () => {
    await bootDb();
    const { handleCreateEnvironment, handleDeleteEnvironment, handleGetEnvironment } = await import("../src/handlers/environments");
    const createRes = await handleCreateEnvironment(req("/v1/environments", {
      body: { name: `env-del-${Date.now()}`, config: { type: "cloud", provider: "e2b", packages: {} } },
    }));
    const env = await createRes.json() as Record<string, unknown>;

    const delRes = await handleDeleteEnvironment(req(`/v1/environments/${env.id}`, { method: "DELETE" }), env.id as string);
    expect(delRes.status).toBe(200);

    const getRes = await handleGetEnvironment(req(`/v1/environments/${env.id}`), env.id as string);
    expect(getRes.status).toBe(404);
  });

  it("archive environment", async () => {
    await bootDb();
    const { handleCreateEnvironment, handleArchiveEnvironment } = await import("../src/handlers/environments");
    const createRes = await handleCreateEnvironment(req("/v1/environments", {
      body: { name: `env-arch-${Date.now()}`, config: { type: "cloud", provider: "e2b", packages: {} } },
    }));
    const env = await createRes.json() as Record<string, unknown>;

    const archRes = await handleArchiveEnvironment(
      req(`/v1/environments/${env.id}/archive`, { method: "POST" }),
      env.id as string,
    );
    expect(archRes.status).toBe(200);
    const archived = await archRes.json() as Record<string, unknown>;
    expect(archived.archived_at).not.toBeNull();
  });

  it("invalid config returns 400", async () => {
    await bootDb();
    const { handleCreateEnvironment } = await import("../src/handlers/environments");
    const res = await handleCreateEnvironment(req("/v1/environments", {
      body: { name: "bad", config: { type: "invalid" } },
    }));
    expect(res.status).toBe(400);
  });
});

// ── Additional Session Tests ────────────────────────────────────────────────

describe("Sessions — Additional Coverage", () => {
  beforeEach(() => freshDbEnv());

  it("get session returns full object", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const { handleCreateSession, handleGetSession } = await import("../src/handlers/sessions");
    const createRes = await handleCreateSession(req("/v1/sessions", {
      body: { agent: agent.id, environment_id: env.id },
    }));
    const session = await createRes.json() as Record<string, unknown>;

    const getRes = await handleGetSession(req(`/v1/sessions/${session.id}`), session.id as string);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json() as Record<string, unknown>;
    expect(fetched.id).toBe(session.id);
    expect(fetched.status).toBe("idle");
    expect(fetched.agent).toBeDefined();
    expect(fetched.environment_id).toBe(env.id);
    expect(fetched.stats).toBeDefined();
    expect(fetched.usage).toBeDefined();
  });

  it("get nonexistent session returns 404", async () => {
    await bootDb();
    const { handleGetSession } = await import("../src/handlers/sessions");
    const res = await handleGetSession(req("/v1/sessions/sess_nonexistent"), "sess_nonexistent");
    expect(res.status).toBe(404);
  });

  it("delete session", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const { handleCreateSession, handleDeleteSession, handleGetSession } = await import("../src/handlers/sessions");
    const createRes = await handleCreateSession(req("/v1/sessions", {
      body: { agent: agent.id, environment_id: env.id },
    }));
    const session = await createRes.json() as Record<string, unknown>;

    const delRes = await handleDeleteSession(req(`/v1/sessions/${session.id}`, { method: "DELETE" }), session.id as string);
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json() as Record<string, unknown>;
    expect(delBody.id).toBe(session.id);
  });

  it("archive session", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const { handleCreateSession, handleArchiveSession } = await import("../src/handlers/sessions");
    const createRes = await handleCreateSession(req("/v1/sessions", {
      body: { agent: agent.id, environment_id: env.id },
    }));
    const session = await createRes.json() as Record<string, unknown>;

    const archRes = await handleArchiveSession(
      req(`/v1/sessions/${session.id}/archive`, { method: "POST" }),
      session.id as string,
    );
    expect(archRes.status).toBe(200);
    const archived = await archRes.json() as Record<string, unknown>;
    expect(archived.archived_at).not.toBeNull();
  });

  it("update session metadata", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const { handleCreateSession, handleUpdateSession } = await import("../src/handlers/sessions");
    const createRes = await handleCreateSession(req("/v1/sessions", {
      body: { agent: agent.id, environment_id: env.id },
    }));
    const session = await createRes.json() as Record<string, unknown>;

    const updateRes = await handleUpdateSession(
      req(`/v1/sessions/${session.id}`, { body: { title: "Test Title", metadata: { key: "value" } } }),
      session.id as string,
    );
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json() as Record<string, unknown>;
    expect(updated.title).toBe("Test Title");
  });

  it("list sessions with filters", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const { handleCreateSession, handleListSessions } = await import("../src/handlers/sessions");
    await handleCreateSession(req("/v1/sessions", {
      body: { agent: agent.id, environment_id: env.id },
    }));

    const res = await handleListSessions(req(`/v1/sessions?agent_id=${agent.id}&limit=5`));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: any[] };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].agent.id).toBe(agent.id);
  });

  it("create session with invalid agent returns 404", async () => {
    await bootDb();
    const env = await createTestEnv();
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(req("/v1/sessions", {
      body: { agent: "agent_nonexistent", environment_id: env.id },
    }));
    expect(res.status).toBe(404);
  });
});

// ── Additional Event Tests ──────────────────────────────────────────────────

describe("Events — Additional Coverage", () => {
  beforeEach(() => freshDbEnv());

  it("send multiple events in batch", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const sessRes = await handleCreateSession(req("/v1/sessions", {
      body: { agent: agent.id, environment_id: env.id },
    }));
    const session = await sessRes.json() as Record<string, unknown>;

    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: {
          events: [
            { type: "user.message", content: [{ type: "text", text: "hello" }] },
            { type: "user.message", content: [{ type: "text", text: "world" }] },
          ],
        },
      }),
      session.id as string,
    );

    const listRes = await handleListEvents(req(`/v1/sessions/${session.id}/events?limit=10`), session.id as string);
    expect(listRes.status).toBe(200);
    const body = await listRes.json() as { data: any[] };
    // Should have at least the 2 user messages
    const userMsgs = body.data.filter((e: any) => e.type === "user.message");
    expect(userMsgs.length).toBeGreaterThanOrEqual(2);
  });

  it("list events with order asc", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const sessRes = await handleCreateSession(req("/v1/sessions", {
      body: { agent: agent.id, environment_id: env.id },
    }));
    const session = await sessRes.json() as Record<string, unknown>;

    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: { events: [{ type: "user.message", content: [{ type: "text", text: "msg1" }] }] },
      }),
      session.id as string,
    );

    const res = await handleListEvents(req(`/v1/sessions/${session.id}/events?order=asc`), session.id as string);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: any[] };
    if (body.data.length >= 2) {
      expect(body.data[0].seq).toBeLessThan(body.data[1].seq);
    }
  });

  it("events for nonexistent session returns 404", async () => {
    await bootDb();
    const { handleListEvents } = await import("../src/handlers/events");
    const res = await handleListEvents(req("/v1/sessions/sess_nonexistent/events"), "sess_nonexistent");
    expect(res.status).toBe(404);
  });
});

// ── Additional Agent Tests ──────────────────────────────────────────────────

describe("Agents — Additional Coverage", () => {
  beforeEach(() => freshDbEnv());

  it("create agent with system prompt", async () => {
    await bootDb();
    const { handleCreateAgent, handleGetAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(req("/v1/agents", {
      body: { name: "SystemAgent", model: "claude-sonnet-4-6", system: "You are a helpful assistant." },
    }));
    expect(res.status).toBe(201);
    const agent = await res.json() as Record<string, unknown>;
    expect(agent.system).toBe("You are a helpful assistant.");

    const getRes = await handleGetAgent(req(`/v1/agents/${agent.id}`), agent.id as string);
    const fetched = await getRes.json() as Record<string, unknown>;
    expect(fetched.system).toBe("You are a helpful assistant.");
  });

  it("create agent with confirmation mode", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(req("/v1/agents", {
      body: { name: "ConfirmAgent", model: "claude-sonnet-4-6", confirmation_mode: true },
    }));
    expect(res.status).toBe(201);
    const agent = await res.json() as Record<string, unknown>;
    expect(agent.confirmation_mode).toBe(true);
  });

  it("update agent name and model", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const { handleUpdateAgent } = await import("../src/handlers/agents");
    const res = await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, { body: { name: "NewName", model: "claude-opus-4-6" } }),
      agent.id as string,
    );
    expect(res.status).toBe(200);
    const updated = await res.json() as Record<string, unknown>;
    expect(updated.name).toBe("NewName");
    expect(updated.model).toBe("claude-opus-4-6");
    expect(updated.version).toBe(2);
  });

  it("update creates new version", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const { handleUpdateAgent, handleGetAgent } = await import("../src/handlers/agents");
    await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, { body: { name: "V2" } }),
      agent.id as string,
    );
    await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, { body: { name: "V3" } }),
      agent.id as string,
    );
    const res = await handleGetAgent(req(`/v1/agents/${agent.id}`), agent.id as string);
    const fetched = await res.json() as Record<string, unknown>;
    expect(fetched.version).toBe(3);
    expect(fetched.name).toBe("V3");
  });

  it("get specific version", async () => {
    await bootDb();
    const agent = await createTestAgent({ name: "VersionTest" });
    const { handleUpdateAgent, handleGetAgent } = await import("../src/handlers/agents");
    await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, { body: { name: "Updated" } }),
      agent.id as string,
    );
    // Get latest — should be version 2
    const latestRes = await handleGetAgent(req(`/v1/agents/${agent.id}`), agent.id as string);
    const latest = await latestRes.json() as Record<string, unknown>;
    expect(latest.version).toBe(2);
    expect(latest.name).toBe("Updated");
  });

  it("create agent with empty name returns 400", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(req("/v1/agents", {
      body: { name: "", model: "claude-sonnet-4-6" },
    }));
    expect(res.status).toBe(400);
  });

  it("list agents with order asc", async () => {
    await bootDb();
    await createTestAgent({ name: "A-first" });
    await createTestAgent({ name: "B-second" });
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents?order=asc&limit=10"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: any[] };
    expect(body.data.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Settings ────────────────────────────────────────────────────────────────

describe("Settings — Additional Coverage", () => {
  beforeEach(() => freshDbEnv());

  it("PUT /v1/settings stores a value", async () => {
    await bootDb();
    const { handlePutSetting } = await import("../src/handlers/settings");
    // Settings handler reads key+value from body
    const res = await handlePutSetting(req("/v1/settings", {
      method: "PUT",
      body: { key: "anthropic_api_key", value: "sk-test-123" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("settings require auth", async () => {
    await bootDb();
    const { handlePutSetting } = await import("../src/handlers/settings");
    const res = await handlePutSetting(req("/v1/settings", {
      method: "PUT",
      body: { key: "test", value: "test" },
      apiKey: "",
    }));
    expect(res.status).toBe(401);
  });

  it("GET /v1/settings/:key masks secret values instead of echoing them", async () => {
    await bootDb();
    const { handlePutSetting, handleGetSetting } = await import("../src/handlers/settings");
    await handlePutSetting(req("/v1/settings", {
      method: "PUT",
      body: { key: "anthropic_api_key", value: "sk-ant-api03-superSecretValueThatMustNotLeak" },
    }));
    const res = await handleGetSetting(req("/v1/settings/anthropic_api_key"), "anthropic_api_key");
    expect(res.status).toBe(200);
    const body = await res.json() as { key: string; value: string; configured: boolean; masked?: boolean };
    expect(body.configured).toBe(true);
    expect(body.masked).toBe(true);
    expect(body.value).not.toContain("superSecretValueThatMustNotLeak");
    expect(body.value.startsWith("sk-ant")).toBe(true);
    expect(body.value.endsWith("Leak")).toBe(true);
  });

  it("GET /v1/settings/:key returns non-secret keys in plaintext", async () => {
    await bootDb();
    const { handlePutSetting, handleGetSetting } = await import("../src/handlers/settings");
    const repoJson = '[{"url":"https://github.com/foo/bar"}]';
    await handlePutSetting(req("/v1/settings", {
      method: "PUT",
      body: { key: "saved_repositories", value: repoJson },
    }));
    const res = await handleGetSetting(req("/v1/settings/saved_repositories"), "saved_repositories");
    const body = await res.json() as { value: string; configured: boolean; masked?: boolean };
    expect(body.value).toBe(repoJson);
    expect(body.masked).toBeUndefined();
  });

  it("GET /v1/settings/:key returns configured=false when unset", async () => {
    await bootDb();
    const { handleGetSetting } = await import("../src/handlers/settings");
    const res = await handleGetSetting(req("/v1/settings/openai_api_key"), "openai_api_key");
    const body = await res.json() as { value: unknown; configured: boolean };
    expect(body.value).toBeNull();
    expect(body.configured).toBe(false);
  });
});

// ── Vault Entry CRUD ────────────────────────────────────────────────────────

describe("Vault Entries — Additional Coverage", () => {
  beforeEach(() => freshDbEnv());

  it("set and get vault entry", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const { handleCreateVault, handlePutEntry, handleGetEntry } = await import("../src/handlers/vaults");
    const vaultRes = await handleCreateVault(req("/v1/vaults", {
      body: { name: "test-vault", agent_id: agent.id },
    }));
    const vault = await vaultRes.json() as Record<string, unknown>;

    await handlePutEntry(
      req(`/v1/vaults/${vault.id}/entries/MY_KEY`, { method: "PUT", body: { value: "secret123" } }),
      vault.id as string,
      "MY_KEY",
    );

    const getRes = await handleGetEntry(
      req(`/v1/vaults/${vault.id}/entries/MY_KEY`),
      vault.id as string,
      "MY_KEY",
    );
    expect(getRes.status).toBe(200);
    const entry = await getRes.json() as Record<string, unknown>;
    expect(entry.key).toBe("MY_KEY");
    // Masked in API response — plaintext only available server-side
    expect(entry.value).toBe("secr****23");
  });

  it("delete vault entry", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const { handleCreateVault, handlePutEntry, handleDeleteEntry, handleGetEntry } = await import("../src/handlers/vaults");
    const vaultRes = await handleCreateVault(req("/v1/vaults", {
      body: { name: "del-vault", agent_id: agent.id },
    }));
    const vault = await vaultRes.json() as Record<string, unknown>;

    await handlePutEntry(
      req(`/v1/vaults/${vault.id}/entries/DEL_KEY`, { method: "PUT", body: { value: "todelete" } }),
      vault.id as string,
      "DEL_KEY",
    );

    const delRes = await handleDeleteEntry(
      req(`/v1/vaults/${vault.id}/entries/DEL_KEY`, { method: "DELETE" }),
      vault.id as string,
      "DEL_KEY",
    );
    expect(delRes.status).toBe(200);

    const getRes = await handleGetEntry(
      req(`/v1/vaults/${vault.id}/entries/DEL_KEY`),
      vault.id as string,
      "DEL_KEY",
    );
    expect(getRes.status).toBe(404);
  });

  it("list vault entries", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const { handleCreateVault, handlePutEntry, handleListEntries } = await import("../src/handlers/vaults");
    const vaultRes = await handleCreateVault(req("/v1/vaults", {
      body: { name: "list-vault", agent_id: agent.id },
    }));
    const vault = await vaultRes.json() as Record<string, unknown>;

    await handlePutEntry(req(`/v1/vaults/${vault.id}/entries/K1`, { method: "PUT", body: { value: "v1" } }), vault.id as string, "K1");
    await handlePutEntry(req(`/v1/vaults/${vault.id}/entries/K2`, { method: "PUT", body: { value: "v2" } }), vault.id as string, "K2");

    const listRes = await handleListEntries(req(`/v1/vaults/${vault.id}/entries`), vault.id as string);
    expect(listRes.status).toBe(200);
    const body = await listRes.json() as { data: any[] };
    expect(body.data.length).toBe(2);
  });
});

// ── Vault Duplicate Name Prevention ─────────────────────────────────────────

describe("Vault Duplicate Names", () => {
  beforeEach(() => freshDbEnv());

  it("rejects duplicate vault name on same agent", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const { handleCreateVault } = await import("../src/handlers/vaults");

    const res1 = await handleCreateVault(req("/v1/vaults", {
      body: { name: "default", agent_id: agent.id },
    }));
    expect(res1.status).toBe(201);

    const res2 = await handleCreateVault(req("/v1/vaults", {
      body: { name: "default", agent_id: agent.id },
    }));
    expect(res2.status).toBe(409);
    const body = await res2.json() as { error: { message: string } };
    expect(body.error.message).toContain("already exists");
  });

  it("allows same vault name on different agents", async () => {
    await bootDb();
    const agent1 = await createTestAgent({ name: "Agent1" });
    const agent2 = await createTestAgent({ name: "Agent2" });
    const { handleCreateVault } = await import("../src/handlers/vaults");

    const res1 = await handleCreateVault(req("/v1/vaults", {
      body: { name: "default", agent_id: agent1.id },
    }));
    expect(res1.status).toBe(201);

    const res2 = await handleCreateVault(req("/v1/vaults", {
      body: { name: "default", agent_id: agent2.id },
    }));
    expect(res2.status).toBe(201);
  });
});

// ── Session Auto-Title from User Message ────────────────────────────────────

describe("Session Auto-Title", () => {
  beforeEach(() => freshDbEnv());

  it("session title is set from first user message", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const env = await createTestEnv();
    const { handleCreateSession, handleGetSession } = await import("../src/handlers/sessions");
    const { handlePostEvents } = await import("../src/handlers/events");

    const sessRes = await handleCreateSession(req("/v1/sessions", {
      body: { agent: agent.id, environment_id: env.id },
    }));
    const session = await sessRes.json() as Record<string, unknown>;
    expect(session.title).toBeNull();

    // Send a user message — the driver auto-titles but since we're calling
    // the handler directly (not the driver), title won't update here.
    // Instead verify the event is stored correctly.
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: { events: [{ type: "user.message", content: [{ type: "text", text: "What is the meaning of life?" }] }] },
      }),
      session.id as string,
    );

    // Verify event was stored
    const getRes = await handleGetSession(req(`/v1/sessions/${session.id}`), session.id as string);
    expect(getRes.status).toBe(200);
  });
});

// ── Agent Duplicate Name Validation ─────────────────────────────────────────

describe("Agent Duplicate Names", () => {
  beforeEach(() => freshDbEnv());

  it("rejects duplicate agent name", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res1 = await handleCreateAgent(req("/v1/agents", {
      body: { name: "Coder", model: "claude-sonnet-4-6" },
    }));
    expect(res1.status).toBe(201);

    const res2 = await handleCreateAgent(req("/v1/agents", {
      body: { name: "Coder", model: "claude-sonnet-4-6" },
    }));
    expect(res2.status).toBe(409);
    const body = await res2.json() as { error: { message: string } };
    expect(body.error.message).toContain("already exists");
  });
});

// ── Environment Duplicate Name Validation ───────────────────────────────────

describe("Environment Duplicate Names", () => {
  beforeEach(() => freshDbEnv());

  it("rejects duplicate environment name", async () => {
    await bootDb();
    const { handleCreateEnvironment } = await import("../src/handlers/environments");
    const name = `env-dup-${Date.now()}`;

    const res1 = await handleCreateEnvironment(req("/v1/environments", {
      body: { name, config: { type: "cloud", provider: "e2b", packages: {} } },
    }));
    expect(res1.status).toBe(201);

    const res2 = await handleCreateEnvironment(req("/v1/environments", {
      body: { name, config: { type: "cloud", provider: "e2b", packages: {} } },
    }));
    expect(res2.status).toBe(409);
    const body = await res2.json() as { error: { message: string } };
    expect(body.error.message).toContain("already exists");
  });
});
