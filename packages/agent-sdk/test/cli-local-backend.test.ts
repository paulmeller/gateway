// @ts-nocheck — test file with loose typing on handler responses
/**
 * CLI LocalBackend handler flow tests.
 *
 * Simulates what LocalBackend does: constructing Request objects with the
 * correct method/path/headers/body and calling handler functions directly.
 * This verifies the end-to-end handler path that the CLI uses without
 * needing a real HTTP server or provider infrastructure.
 *
 * 55+ tests covering quickstart flow, agents, environments, sessions, events,
 * vaults, memory stores, batch, settings, and error handling.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-local-test-"));
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
  const { key } = createApiKey({ name: "test", permissions: ["*"], rawKey: "cli-test-api-key-12345" });
  return key;
}

const TEST_API_KEY = "cli-test-api-key-12345";

/**
 * Build a Request the same way LocalBackend.callHandler does:
 * correct method/path/headers/body, authenticated with x-api-key.
 */
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
    headers["x-api-key"] = TEST_API_KEY;
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/**
 * Simulate LocalBackend.callHandler: call the handler, parse response JSON,
 * throw on non-2xx with the server's error message — exactly as LocalBackend does.
 */
async function callHandler<T = unknown>(
  handler: (req: Request, ...ids: string[]) => Promise<Response>,
  method: string,
  url: string,
  body?: unknown,
  ...ids: string[]
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": TEST_API_KEY,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const request = new Request(`http://localhost${url}`, init);
  const res = await handler(request, ...ids);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `HTTP ${res.status}`;
    try {
      const err = JSON.parse(text) as { error?: { type?: string; message?: string } };
      if (err?.error?.message) msg = `${err.error.type ?? "error"}: ${err.error.message}`;
    } catch { /* use default msg */ }
    throw new Error(msg);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Build a localhost URL with optional query params — mirrors LocalBackend.url() */
function buildUrl(urlPath: string, params?: Record<string, string | number | boolean | undefined>): string {
  const u = new URL(`http://localhost${urlPath}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
  }
  return u.pathname + (u.search ? u.search : "");
}

// ---------------------------------------------------------------------------
// Test helpers (shortcuts mirroring LocalBackend methods)
// ---------------------------------------------------------------------------

async function createAgent(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { handleCreateAgent } = await import("../src/handlers/agents");
  return callHandler(
    handleCreateAgent,
    "POST",
    "/v1/agents",
    { name: `Agent-${Date.now()}-${Math.random()}`, model: "claude-sonnet-4-6", ...overrides },
  );
}

/** Create environment directly in DB (bypasses provider availability checks). */
async function createEnv(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { getDb } = await import("../src/db/client");
  const { newId } = await import("../src/util/ids");
  const { nowMs, toIso } = await import("../src/util/clock");

  const db = getDb();
  const id = newId("env");
  const now = nowMs();
  const name = (overrides.name as string) ?? `env-${Date.now()}-${Math.random()}`;
  const config = overrides.config ?? { type: "cloud", provider: "sprites" };

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

async function createSession(
  agentId: string,
  envId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { handleCreateSession } = await import("../src/handlers/sessions");
  return callHandler(
    handleCreateSession,
    "POST",
    "/v1/sessions",
    { agent: agentId, environment_id: envId, ...overrides },
  );
}

async function createVault(agentId: string, name: string): Promise<Record<string, unknown>> {
  const { handleCreateVault } = await import("../src/handlers/vaults");
  return callHandler(handleCreateVault, "POST", "/v1/vaults", { agent_id: agentId, name });
}

async function createMemoryStore(name: string, description?: string, agentId?: string): Promise<Record<string, unknown>> {
  // v0.5: memory stores require an agent_id. Create one if not provided.
  let aid = agentId;
  if (!aid) {
    const agent = await createAgent(`mem-agent-${Date.now()}`);
    aid = agent.id as string;
  }
  const { handleCreateMemoryStore } = await import("../src/handlers/memory");
  return callHandler(handleCreateMemoryStore, "POST", "/v1/memory_stores", { name, description, agent_id: aid });
}

// ---------------------------------------------------------------------------
// Quickstart Flow
// ---------------------------------------------------------------------------

describe("Quickstart Flow", () => {
  beforeEach(() => freshDbEnv());

  it("full quickstart: create agent, env, vault, session, post message", async () => {
    await bootDb();

    // 1. Create agent
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agent = await callHandler<Record<string, unknown>>(
      handleCreateAgent,
      "POST",
      "/v1/agents",
      { name: "QuickstartAgent", model: "claude-sonnet-4-6" },
    );
    expect(agent.id).toBeTruthy();
    expect(agent.name).toBe("QuickstartAgent");

    // 2. Create env (DB insert to ready state)
    const env = await createEnv({ name: "QuickstartEnv" });
    expect(env.id).toBeTruthy();
    expect(env.state).toBe("ready");

    // 3. Create vault
    const { handleCreateVault } = await import("../src/handlers/vaults");
    const vault = await callHandler<Record<string, unknown>>(
      handleCreateVault,
      "POST",
      "/v1/vaults",
      { agent_id: agent.id, name: "secrets" },
    );
    expect(vault.id).toBeTruthy();
    expect(vault.agent_id).toBe(agent.id);

    // 4. Set vault entry
    const { handlePutEntry } = await import("../src/handlers/vaults");
    const entry = await callHandler<Record<string, unknown>>(
      handlePutEntry,
      "PUT",
      `/v1/vaults/${vault.id}/entries/MY_SECRET`,
      { value: "supersecret" },
      vault.id as string,
      "MY_SECRET",
    );
    expect(entry.key).toBe("MY_SECRET");
    expect(entry.ok).toBe(true);

    // 5. Create session with vault
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const session = await callHandler<Record<string, unknown>>(
      handleCreateSession,
      "POST",
      "/v1/sessions",
      { agent: agent.id, environment_id: env.id, vault_ids: [vault.id] },
    );
    expect(session.id).toBeTruthy();
    expect(session.status).toBe("idle");

    // 6. Post user message
    const { handlePostEvents } = await import("../src/handlers/events");
    const result = await callHandler<{ events: Array<{ type: string }> }>(
      handlePostEvents,
      "POST",
      `/v1/sessions/${session.id}/events`,
      { events: [{ type: "user.message", content: [{ type: "text", text: "Hello agent!" }] }] },
      session.id as string,
    );
    expect(result.data.length).toBe(1);
    expect(result.data[0].type).toBe("user.message");
  });

  it("quickstart with different engine (codex)", async () => {
    await bootDb();
    const agent = await createAgent({ name: "CodexAgent", engine: "codex", model: "codex-mini-latest" });
    expect(agent.engine).toBe("codex");
    expect(agent.model).toBe("codex-mini-latest");
  });

  it("agent creation returns id, name, model, engine", async () => {
    await bootDb();
    const agent = await createAgent({ name: "FieldsAgent", model: "claude-sonnet-4-6" });
    expect(agent).toHaveProperty("id");
    expect(agent).toHaveProperty("name", "FieldsAgent");
    expect(agent).toHaveProperty("model", "claude-sonnet-4-6");
    expect(agent).toHaveProperty("engine", "claude");
  });

  it("environment creation with provider config", async () => {
    await bootDb();
    const env = await createEnv({ name: "ProviderEnv", config: { type: "cloud", provider: "docker" } });
    expect(env.id).toBeTruthy();
    expect((env.config as Record<string, unknown>).provider).toBe("docker");
  });

  it("vault creation with agent_id", async () => {
    await bootDb();
    const agent = await createAgent({ name: "VaultCreationAgent" });
    const vault = await createVault(agent.id as string, "myvault");
    expect(vault.id).toBeTruthy();
    expect(vault.agent_id).toBe(agent.id);
    expect(vault.name).toBe("myvault");
  });

  it("vault entry set/get roundtrip", async () => {
    await bootDb();
    const agent = await createAgent({ name: "RoundtripAgent" });
    const vault = await createVault(agent.id as string, "roundtrip");

    const { handlePutEntry, handleGetEntry } = await import("../src/handlers/vaults");
    await callHandler(
      handlePutEntry,
      "PUT",
      `/v1/vaults/${vault.id}/entries/API_KEY`,
      { value: "sk-12345" },
      vault.id as string,
      "API_KEY",
    );
    const got = await callHandler<Record<string, unknown>>(
      handleGetEntry,
      "GET",
      `/v1/vaults/${vault.id}/entries/API_KEY`,
      undefined,
      vault.id as string,
      "API_KEY",
    );
    expect(got.key).toBe("API_KEY");
    expect(got.value).toBe("sk-1****45"); // masked
  });

  it("session creation with vault_ids", async () => {
    await bootDb();
    const agent = await createAgent({ name: "VaultSessionAgent" });
    const env = await createEnv({ name: "VaultSessionEnv" });
    const vault = await createVault(agent.id as string, "vsecrets");

    const session = await createSession(agent.id as string, env.id as string, {
      vault_ids: [vault.id],
    });
    expect(session.vault_ids).toEqual([vault.id]);
  });

  it("post user.message to session returns events", async () => {
    await bootDb();
    const agent = await createAgent({ name: "PostMsgAgent" });
    const env = await createEnv({ name: "PostMsgEnv" });
    const session = await createSession(agent.id as string, env.id as string);

    const { handlePostEvents } = await import("../src/handlers/events");
    const result = await callHandler<{ data: Array<{ type: string; content?: unknown }> }>(
      handlePostEvents,
      "POST",
      `/v1/sessions/${session.id}/events`,
      { events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }] },
      session.id as string,
    );
    expect(result.data).toBeDefined();
    expect(result.data.length).toBeGreaterThanOrEqual(1);
    expect(result.data[0].type).toBe("user.message");
  });

  it("list events returns posted message", async () => {
    await bootDb();
    const agent = await createAgent({ name: "ListMsgAgent" });
    const env = await createEnv({ name: "ListMsgEnv" });
    const session = await createSession(agent.id as string, env.id as string);

    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await callHandler(
      handlePostEvents,
      "POST",
      `/v1/sessions/${session.id}/events`,
      { events: [{ type: "user.message", content: [{ type: "text", text: "listed" }] }] },
      session.id as string,
    );
    const list = await callHandler<{ data: Array<{ type: string }> }>(
      handleListEvents,
      "GET",
      `/v1/sessions/${session.id}/events`,
      undefined,
      session.id as string,
    );
    expect(list.data.some((e) => e.type === "user.message")).toBe(true);
  });

  it("session status is idle after creation", async () => {
    await bootDb();
    const agent = await createAgent({ name: "StatusAgent" });
    const env = await createEnv({ name: "StatusEnv" });
    const session = await createSession(agent.id as string, env.id as string);
    expect(session.status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Agent CLI Operations
// ---------------------------------------------------------------------------

describe("Agent CLI Operations", () => {
  beforeEach(() => freshDbEnv());

  it("agents create returns agent", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(
      req("/v1/agents", { body: { name: "CLIAgent", model: "claude-sonnet-4-6" } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("CLIAgent");
    expect(body.id).toBeTruthy();
  });

  it("agents list returns paginated data", async () => {
    await bootDb();
    await createAgent({ name: "ListA1" });
    await createAgent({ name: "ListA2" });
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; next_page: string | null };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
    expect("next_page" in body).toBe(true);
  });

  it("agents get returns agent by id", async () => {
    await bootDb();
    const agent = await createAgent({ name: "GetByIdAgent" });
    const { handleGetAgent } = await import("../src/handlers/agents");
    const result = await callHandler<Record<string, unknown>>(
      handleGetAgent,
      "GET",
      `/v1/agents/${agent.id}`,
      undefined,
      agent.id as string,
    );
    expect(result.id).toBe(agent.id);
    expect(result.name).toBe("GetByIdAgent");
  });

  it("agents update updates fields", async () => {
    await bootDb();
    const agent = await createAgent({ name: "UpdateMe" });
    const { handleUpdateAgent } = await import("../src/handlers/agents");
    const result = await callHandler<Record<string, unknown>>(
      handleUpdateAgent,
      "POST",
      `/v1/agents/${agent.id}`,
      { name: "UpdatedName", system: "new system prompt" },
      agent.id as string,
    );
    expect(result.name).toBe("UpdatedName");
    expect(result.system).toBe("new system prompt");
  });

  it("agents delete deletes agent", async () => {
    await bootDb();
    const agent = await createAgent({ name: "DeleteMeAgent" });
    const { handleDeleteAgent, handleListAgents } = await import("../src/handlers/agents");
    const result = await callHandler<Record<string, unknown>>(
      handleDeleteAgent,
      "DELETE",
      `/v1/agents/${agent.id}`,
      undefined,
      agent.id as string,
    );
    expect(result.type).toBe("agent_deleted");

    // Deleted (archived) agent should not appear in default list
    const listRes = await handleListAgents(req("/v1/agents"));
    const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
    const ids = listBody.data.map((a) => a.id);
    expect(ids).not.toContain(agent.id);
  });

  it("agents list with limit", async () => {
    await bootDb();
    await createAgent({ name: "LimA1" });
    await createAgent({ name: "LimA2" });
    await createAgent({ name: "LimA3" });
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents?limit=2"));
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(2);
  });

  it("agents list order asc vs desc", async () => {
    await bootDb();
    await createAgent({ name: "OrderA1" });
    await createAgent({ name: "OrderA2" });
    await createAgent({ name: "OrderA3" });
    const { handleListAgents } = await import("../src/handlers/agents");

    const ascRes = await handleListAgents(req("/v1/agents?order=asc"));
    const ascBody = (await ascRes.json()) as { data: Array<{ id: string; name: string }> };

    const descRes = await handleListAgents(req("/v1/agents?order=desc"));
    const descBody = (await descRes.json()) as { data: Array<{ id: string; name: string }> };

    // Both should contain the same 3 agents
    expect(ascBody.data.length).toBe(3);
    expect(descBody.data.length).toBe(3);

    // Asc first element should be desc last element (reversed order)
    expect(ascBody.data[0].id).toBe(descBody.data[descBody.data.length - 1].id);
    expect(ascBody.data[ascBody.data.length - 1].id).toBe(descBody.data[0].id);
  });

  it("agents create with system prompt", async () => {
    await bootDb();
    const agent = await createAgent({
      name: "SystemAgent",
      model: "claude-sonnet-4-6",
      system: "You are a helpful coding assistant.",
    });
    expect(agent.system).toBe("You are a helpful coding assistant.");
  });
});

// ---------------------------------------------------------------------------
// Environment CLI Operations
// ---------------------------------------------------------------------------

describe("Environment CLI Operations", () => {
  beforeEach(() => freshDbEnv());

  it("environments create returns env", async () => {
    await bootDb();
    // Create directly in DB to avoid provider availability check (no providers in test)
    const env = await createEnv({ name: "CLIEnv", config: { type: "cloud" } });
    expect(env.id).toBeTruthy();
    expect(env.name).toBe("CLIEnv");
    expect(env.state).toBe("ready");
  });

  it("environments list returns paginated data", async () => {
    await bootDb();
    await createEnv({ name: "ListEnv1" });
    await createEnv({ name: "ListEnv2" });
    const { handleListEnvironments } = await import("../src/handlers/environments");
    const res = await handleListEnvironments(req("/v1/environments"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; next_page: string | null };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
    expect("next_page" in body).toBe(true);
  });

  it("environments get returns env by id", async () => {
    await bootDb();
    const env = await createEnv({ name: "GetEnvById" });
    const { handleGetEnvironment } = await import("../src/handlers/environments");
    const result = await callHandler<Record<string, unknown>>(
      handleGetEnvironment,
      "GET",
      `/v1/environments/${env.id}`,
      undefined,
      env.id as string,
    );
    expect(result.id).toBe(env.id);
    expect(result.name).toBe("GetEnvById");
  });

  it("environments delete works", async () => {
    await bootDb();
    const env = await createEnv({ name: "DeleteEnv" });
    const { handleDeleteEnvironment } = await import("../src/handlers/environments");
    const result = await callHandler<Record<string, unknown>>(
      handleDeleteEnvironment,
      "DELETE",
      `/v1/environments/${env.id}`,
      undefined,
      env.id as string,
    );
    expect(result.type).toBe("environment_deleted");
  });

  it("environments archive marks as archived", async () => {
    await bootDb();
    const env = await createEnv({ name: "ArchiveEnv" });
    const { handleArchiveEnvironment } = await import("../src/handlers/environments");
    const result = await callHandler<Record<string, unknown>>(
      handleArchiveEnvironment,
      "POST",
      `/v1/environments/${env.id}/archive`,
      {},
      env.id as string,
    );
    expect(result.archived_at).not.toBeNull();
  });

  it("environments list excludes archived", async () => {
    await bootDb();
    const e1 = await createEnv({ name: "ActiveEnv" });
    const e2 = await createEnv({ name: "ArchivedEnv" });
    const { handleArchiveEnvironment, handleListEnvironments } = await import("../src/handlers/environments");
    await callHandler(
      handleArchiveEnvironment,
      "POST",
      `/v1/environments/${e2.id}/archive`,
      {},
      e2.id as string,
    );
    const list = await callHandler<{ data: Array<{ id: string }> }>(
      handleListEnvironments,
      "GET",
      "/v1/environments",
    );
    const ids = list.data.map((e) => e.id);
    expect(ids).toContain(e1.id);
    expect(ids).not.toContain(e2.id);
  });

  it("environments create with packages config", async () => {
    await bootDb();
    // Create directly in DB with packages config (no provider availability check in test)
    const env = await createEnv({
      name: "PkgEnv",
      config: { type: "cloud", provider: "sprites", packages: { npm: ["express"] } },
    });
    expect(env.id).toBeTruthy();
    expect(env.name).toBe("PkgEnv");
    const cfg = env.config as Record<string, unknown>;
    expect(cfg.packages).toBeDefined();
  });

  it("environment state starts as ready after direct DB insert", async () => {
    await bootDb();
    // In tests we insert directly to bypass provider — state is always 'ready'
    const env = await createEnv({ name: "StateEnv", config: { type: "cloud" } });
    expect(env.state).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Session CLI Operations
// ---------------------------------------------------------------------------

describe("Session CLI Operations", () => {
  beforeEach(() => freshDbEnv());

  it("sessions create returns session", async () => {
    await bootDb();
    const agent = await createAgent({ name: "SessCreateAgent" });
    const env = await createEnv({ name: "SessCreateEnv" });
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(
      req("/v1/sessions", { body: { agent: agent.id, environment_id: env.id } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("idle");
  });

  it("sessions list returns paginated data", async () => {
    await bootDb();
    const agent = await createAgent({ name: "SessListAgent" });
    const env = await createEnv({ name: "SessListEnv" });
    await createSession(agent.id as string, env.id as string);
    await createSession(agent.id as string, env.id as string);
    const { handleListSessions } = await import("../src/handlers/sessions");
    const res = await handleListSessions(req("/v1/sessions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; next_page: string | null };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
    expect("next_page" in body).toBe(true);
  });

  it("sessions get returns session by id", async () => {
    await bootDb();
    const agent = await createAgent({ name: "SessGetAgent" });
    const env = await createEnv({ name: "SessGetEnv" });
    const session = await createSession(agent.id as string, env.id as string);
    const { handleGetSession } = await import("../src/handlers/sessions");
    const result = await callHandler<Record<string, unknown>>(
      handleGetSession,
      "GET",
      `/v1/sessions/${session.id}`,
      undefined,
      session.id as string,
    );
    expect(result.id).toBe(session.id);
  });

  it("sessions update title works", async () => {
    await bootDb();
    const agent = await createAgent({ name: "TitleUpdateAgent" });
    const env = await createEnv({ name: "TitleUpdateEnv" });
    const session = await createSession(agent.id as string, env.id as string);
    const { handleUpdateSession } = await import("../src/handlers/sessions");
    const result = await callHandler<Record<string, unknown>>(
      handleUpdateSession,
      "POST",
      `/v1/sessions/${session.id}`,
      { title: "CLI Updated Title" },
      session.id as string,
    );
    expect(result.title).toBe("CLI Updated Title");
  });

  it("sessions delete works", async () => {
    await bootDb();
    const agent = await createAgent({ name: "SessDelAgent" });
    const env = await createEnv({ name: "SessDelEnv" });
    const session = await createSession(agent.id as string, env.id as string);
    const { handleDeleteSession } = await import("../src/handlers/sessions");
    const result = await callHandler<Record<string, unknown>>(
      handleDeleteSession,
      "DELETE",
      `/v1/sessions/${session.id}`,
      undefined,
      session.id as string,
    );
    expect(result.type).toBe("session_deleted");
  });

  it("sessions archive marks as archived", async () => {
    await bootDb();
    const agent = await createAgent({ name: "SessArchAgent" });
    const env = await createEnv({ name: "SessArchEnv" });
    const session = await createSession(agent.id as string, env.id as string);
    const { handleArchiveSession } = await import("../src/handlers/sessions");
    const result = await callHandler<Record<string, unknown>>(
      handleArchiveSession,
      "POST",
      `/v1/sessions/${session.id}/archive`,
      {},
      session.id as string,
    );
    expect(result.archived_at).not.toBeNull();
  });

  it("sessions list with status filter", async () => {
    await bootDb();
    const agent = await createAgent({ name: "StatusFilterAgent" });
    const env = await createEnv({ name: "StatusFilterEnv" });
    await createSession(agent.id as string, env.id as string);
    const { handleListSessions } = await import("../src/handlers/sessions");
    const res = await handleListSessions(req("/v1/sessions?status=idle"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ status: string }> };
    body.data.forEach((s) => expect(s.status).toBe("idle"));
  });

  it("sessions list with agent filter", async () => {
    await bootDb();
    const a1 = await createAgent({ name: "AgentFilter1" });
    const a2 = await createAgent({ name: "AgentFilter2" });
    const env = await createEnv({ name: "AgentFilterEnv" });
    await createSession(a1.id as string, env.id as string);
    await createSession(a2.id as string, env.id as string);
    const { handleListSessions } = await import("../src/handlers/sessions");
    const res = await handleListSessions(req(`/v1/sessions?agent_id=${a1.id}`));
    const body = (await res.json()) as { data: Array<{ agent: { id: string } }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0].agent.id).toBe(a1.id);
  });
});

// ---------------------------------------------------------------------------
// Event CLI Operations
// ---------------------------------------------------------------------------

describe("Event CLI Operations", () => {
  beforeEach(() => freshDbEnv());

  it("events send user.message returns events", async () => {
    await bootDb();
    const agent = await createAgent({ name: "SendEvtAgent" });
    const env = await createEnv({ name: "SendEvtEnv" });
    const session = await createSession(agent.id as string, env.id as string);
    const { handlePostEvents } = await import("../src/handlers/events");
    const result = await callHandler<{ data: Array<{ type: string }> }>(
      handlePostEvents,
      "POST",
      `/v1/sessions/${session.id}/events`,
      { events: [{ type: "user.message", content: [{ type: "text", text: "hello CLI" }] }] },
      session.id as string,
    );
    expect(result.data.length).toBe(1);
    expect(result.data[0].type).toBe("user.message");
  });

  it("events list returns events with seq", async () => {
    await bootDb();
    const agent = await createAgent({ name: "ListSeqAgent" });
    const env = await createEnv({ name: "ListSeqEnv" });
    const session = await createSession(agent.id as string, env.id as string);
    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await callHandler(
      handlePostEvents,
      "POST",
      `/v1/sessions/${session.id}/events`,
      { events: [{ type: "user.message", content: [{ type: "text", text: "seqtest" }] }] },
      session.id as string,
    );
    const list = await callHandler<{ data: Array<{ seq: number; type: string }> }>(
      handleListEvents,
      "GET",
      `/v1/sessions/${session.id}/events`,
      undefined,
      session.id as string,
    );
    expect(list.data.length).toBeGreaterThanOrEqual(1);
    expect(typeof list.data[0].seq).toBe("number");
    expect(list.data[0].seq).toBeGreaterThanOrEqual(1);
  });

  it("events list with after_seq", async () => {
    await bootDb();
    const agent = await createAgent({ name: "AfterSeqAgent" });
    const env = await createEnv({ name: "AfterSeqEnv" });
    const session = await createSession(agent.id as string, env.id as string);
    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await callHandler(
      handlePostEvents,
      "POST",
      `/v1/sessions/${session.id}/events`,
      {
        events: [
          { type: "user.message", content: [{ type: "text", text: "one" }] },
          { type: "user.message", content: [{ type: "text", text: "two" }] },
          { type: "user.message", content: [{ type: "text", text: "three" }] },
        ],
      },
      session.id as string,
    );
    const list = await callHandler<{ data: Array<{ seq: number }> }>(
      handleListEvents,
      "GET",
      `/v1/sessions/${session.id}/events?after_seq=2`,
      undefined,
      session.id as string,
    );
    list.data.forEach((e) => expect(e.seq).toBeGreaterThan(2));
  });

  it("events send user.interrupt", async () => {
    await bootDb();
    const agent = await createAgent({ name: "InterruptAgent" });
    const env = await createEnv({ name: "InterruptEnv" });
    const session = await createSession(agent.id as string, env.id as string);
    const { handlePostEvents } = await import("../src/handlers/events");
    const result = await callHandler<{ data: Array<{ type: string }> }>(
      handlePostEvents,
      "POST",
      `/v1/sessions/${session.id}/events`,
      { events: [{ type: "user.interrupt" }] },
      session.id as string,
    );
    expect(result.data[0].type).toBe("user.interrupt");
  });

  it("events send multiple events", async () => {
    await bootDb();
    const agent = await createAgent({ name: "MultiEvtAgent" });
    const env = await createEnv({ name: "MultiEvtEnv" });
    const session = await createSession(agent.id as string, env.id as string);
    const { handlePostEvents } = await import("../src/handlers/events");
    const result = await callHandler<{ data: unknown[] }>(
      handlePostEvents,
      "POST",
      `/v1/sessions/${session.id}/events`,
      {
        events: [
          { type: "user.message", content: [{ type: "text", text: "msg1" }] },
          { type: "user.message", content: [{ type: "text", text: "msg2" }] },
        ],
      },
      session.id as string,
    );
    expect(result.data.length).toBe(2);
  });

  it("events idempotency deduplication", async () => {
    await bootDb();
    const agent = await createAgent({ name: "IdempotentAgent" });
    const env = await createEnv({ name: "IdempotentEnv" });
    const session = await createSession(agent.id as string, env.id as string);
    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");

    const eventBody = {
      events: [{ type: "user.message", content: [{ type: "text", text: "dedup" }] }],
    };
    // Send twice with same idempotency key
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: eventBody,
        headers: { "idempotency-key": "dedup-key-abc" },
      }),
      session.id as string,
    );
    await handlePostEvents(
      req(`/v1/sessions/${session.id}/events`, {
        body: eventBody,
        headers: { "idempotency-key": "dedup-key-abc" },
      }),
      session.id as string,
    );
    const list = await callHandler<{ data: Array<{ type: string }> }>(
      handleListEvents,
      "GET",
      `/v1/sessions/${session.id}/events`,
      undefined,
      session.id as string,
    );
    const userMessages = list.data.filter((e) => e.type === "user.message");
    expect(userMessages.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Vault CLI Operations
// ---------------------------------------------------------------------------

describe("Vault CLI Operations", () => {
  beforeEach(() => freshDbEnv());

  it("vaults create returns vault", async () => {
    await bootDb();
    const agent = await createAgent({ name: "VaultCreateAgent" });
    const { handleCreateVault } = await import("../src/handlers/vaults");
    const res = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "cli-vault" } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("cli-vault");
    expect(body.agent_id).toBe(agent.id);
  });

  it("vaults list returns data", async () => {
    await bootDb();
    const agent = await createAgent({ name: "VaultListAgent" });
    await createVault(agent.id as string, "v1");
    await createVault(agent.id as string, "v2");
    const { handleListVaults } = await import("../src/handlers/vaults");
    const result = await callHandler<{ data: unknown[] }>(handleListVaults, "GET", "/v1/vaults");
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBe(2);
  });

  it("vaults list by agent_id", async () => {
    await bootDb();
    const a1 = await createAgent({ name: "VaultFilterA1" });
    const a2 = await createAgent({ name: "VaultFilterA2" });
    await createVault(a1.id as string, "a1vault");
    await createVault(a2.id as string, "a2vault");
    const { handleListVaults } = await import("../src/handlers/vaults");
    const result = await callHandler<{ data: Array<{ agent_id: string }> }>(
      handleListVaults,
      "GET",
      `/v1/vaults?agent_id=${a1.id}`,
    );
    expect(result.data.length).toBe(1);
    expect(result.data[0].agent_id).toBe(a1.id);
  });

  it("vault entries set stores value", async () => {
    await bootDb();
    const agent = await createAgent({ name: "EntrySetAgent" });
    const vault = await createVault(agent.id as string, "entry-test");
    const { handlePutEntry } = await import("../src/handlers/vaults");
    const result = await callHandler<Record<string, unknown>>(
      handlePutEntry,
      "PUT",
      `/v1/vaults/${vault.id}/entries/MY_TOKEN`,
      { value: "tok_abc123" },
      vault.id as string,
      "MY_TOKEN",
    );
    expect(result.key).toBe("MY_TOKEN");
    expect(result.ok).toBe(true);
  });

  it("vault entries get retrieves value", async () => {
    await bootDb();
    const agent = await createAgent({ name: "EntryGetAgent" });
    const vault = await createVault(agent.id as string, "entry-get");
    const { handlePutEntry, handleGetEntry } = await import("../src/handlers/vaults");
    await callHandler(
      handlePutEntry,
      "PUT",
      `/v1/vaults/${vault.id}/entries/DB_URL`,
      { value: "postgres://localhost/db" },
      vault.id as string,
      "DB_URL",
    );
    const result = await callHandler<Record<string, unknown>>(
      handleGetEntry,
      "GET",
      `/v1/vaults/${vault.id}/entries/DB_URL`,
      undefined,
      vault.id as string,
      "DB_URL",
    );
    expect(result.key).toBe("DB_URL");
    expect(result.value).toBe("post****db"); // masked
  });

  it("vault entries delete removes entry", async () => {
    await bootDb();
    const agent = await createAgent({ name: "EntryDelAgent" });
    const vault = await createVault(agent.id as string, "entry-del");
    const { handlePutEntry, handleDeleteEntry, handleGetEntry } = await import("../src/handlers/vaults");

    await callHandler(
      handlePutEntry,
      "PUT",
      `/v1/vaults/${vault.id}/entries/TEMP`,
      { value: "tempval" },
      vault.id as string,
      "TEMP",
    );
    const delResult = await callHandler<Record<string, unknown>>(
      handleDeleteEntry,
      "DELETE",
      `/v1/vaults/${vault.id}/entries/TEMP`,
      undefined,
      vault.id as string,
      "TEMP",
    );
    expect(delResult.type).toBe("entry_deleted");

    // Verify gone
    const getRes = await handleGetEntry(
      req(`/v1/vaults/${vault.id}/entries/TEMP`),
      vault.id as string,
      "TEMP",
    );
    expect(getRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Memory CLI Operations
// ---------------------------------------------------------------------------

describe("Memory CLI Operations", () => {
  beforeEach(() => freshDbEnv());

  it("memory stores create returns store", async () => {
    await bootDb();
    const agent = await createAgent("mem-cli-agent");
    const { handleCreateMemoryStore } = await import("../src/handlers/memory");
    const res = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "cli-store", agent_id: agent.id } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { name: string; id: string; agent_id: string };
    expect(body.name).toBe("cli-store");
    expect(body.id).toBeTruthy();
    expect(body.agent_id).toBe(agent.id);
  });

  it("memory stores list returns data", async () => {
    await bootDb();
    await createMemoryStore("store1");
    await createMemoryStore("store2");
    const { handleListMemoryStores } = await import("../src/handlers/memory");
    const result = await callHandler<{ data: unknown[] }>(
      handleListMemoryStores,
      "GET",
      "/v1/memory_stores",
    );
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBe(2);
  });

  it("memory create returns memory", async () => {
    await bootDb();
    const store = await createMemoryStore("mem-create-store");
    const { handleCreateMemory } = await import("../src/handlers/memory");
    const result = await callHandler<Record<string, unknown>>(
      handleCreateMemory,
      "POST",
      `/v1/memory_stores/${store.id}/memories`,
      { path: "/notes/intro.md", content: "Welcome to the project." },
      store.id as string,
    );
    expect(result.path).toBe("/notes/intro.md");
    expect(result.content).toBe("Welcome to the project.");
    expect(result.id).toBeTruthy();
  });

  it("memory list returns memories", async () => {
    await bootDb();
    const store = await createMemoryStore("mem-list-store");
    const { handleCreateMemory, handleListMemories } = await import("../src/handlers/memory");
    await callHandler(
      handleCreateMemory,
      "POST",
      `/v1/memory_stores/${store.id}/memories`,
      { path: "/a", content: "aaa" },
      store.id as string,
    );
    await callHandler(
      handleCreateMemory,
      "POST",
      `/v1/memory_stores/${store.id}/memories`,
      { path: "/b", content: "bbb" },
      store.id as string,
    );
    const list = await callHandler<{ data: unknown[] }>(
      handleListMemories,
      "GET",
      `/v1/memory_stores/${store.id}/memories`,
      undefined,
      store.id as string,
    );
    expect(list.data.length).toBe(2);
  });

  it("memory update updates content", async () => {
    await bootDb();
    const store = await createMemoryStore("mem-update-store");
    const { handleCreateMemory, handleUpdateMemory } = await import("../src/handlers/memory");
    const mem = await callHandler<Record<string, unknown>>(
      handleCreateMemory,
      "POST",
      `/v1/memory_stores/${store.id}/memories`,
      { path: "/update-me", content: "original content" },
      store.id as string,
    );
    const updated = await callHandler<Record<string, unknown>>(
      handleUpdateMemory,
      "POST",
      `/v1/memory_stores/${store.id}/memories/${mem.id}`,
      { content: "updated content" },
      store.id as string,
      mem.id as string,
    );
    expect(updated.content).toBe("updated content");
  });

  it("memory delete removes memory", async () => {
    await bootDb();
    const store = await createMemoryStore("mem-delete-store");
    const { handleCreateMemory, handleDeleteMemory, handleGetMemory } = await import("../src/handlers/memory");
    const mem = await callHandler<Record<string, unknown>>(
      handleCreateMemory,
      "POST",
      `/v1/memory_stores/${store.id}/memories`,
      { path: "/delete-me", content: "bye" },
      store.id as string,
    );
    const delResult = await callHandler<Record<string, unknown>>(
      handleDeleteMemory,
      "DELETE",
      `/v1/memory_stores/${store.id}/memories/${mem.id}`,
      undefined,
      store.id as string,
      mem.id as string,
    );
    expect(delResult.type).toBe("memory_deleted");

    // Verify gone
    const getRes = await handleGetMemory(
      req(`/v1/memory_stores/${store.id}/memories/${mem.id}`),
      store.id as string,
      mem.id as string,
    );
    expect(getRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Batch CLI Operations
// ---------------------------------------------------------------------------

describe("Batch CLI Operations", () => {
  beforeEach(() => freshDbEnv());

  it("batch execute returns results", async () => {
    await bootDb();
    const { handleBatch } = await import("../src/handlers/batch");
    const result = await callHandler<{ results: Array<{ status: number; body: unknown }> }>(
      handleBatch,
      "POST",
      "/v1/batch",
      {
        operations: [
          { method: "POST", path: "/v1/environments", body: { name: "BatchEnvX", config: { type: "cloud" } } },
          { method: "POST", path: "/v1/environments", body: { name: "BatchEnvY", config: { type: "cloud" } } },
        ],
      },
    );
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBe(2);
    expect(result.results[0].status).toBe(201);
    expect(result.results[1].status).toBe(201);
  });

  it("batch with mixed operations (multiple environments)", async () => {
    await bootDb();
    const { handleBatch } = await import("../src/handlers/batch");
    // Create multiple environments in one batch — environments don't use nested transactions
    const result = await callHandler<{ results: Array<{ status: number; body: Record<string, unknown> }> }>(
      handleBatch,
      "POST",
      "/v1/batch",
      {
        operations: [
          { method: "POST", path: "/v1/environments", body: { name: "MixedEnvA", config: { type: "cloud" } } },
          { method: "POST", path: "/v1/environments", body: { name: "MixedEnvB", config: { type: "cloud" } } },
          { method: "POST", path: "/v1/environments", body: { name: "MixedEnvC", config: { type: "cloud" } } },
        ],
      },
    );
    expect(result.results.length).toBe(3);
    expect(result.results[0].status).toBe(201);
    expect((result.results[0].body as Record<string, unknown>).name).toBe("MixedEnvA");
    expect(result.results[1].status).toBe(201);
    expect((result.results[2].body as Record<string, unknown>).name).toBe("MixedEnvC");
  });

  it("batch error returns index", async () => {
    await bootDb();
    // Pre-create an agent so we can delete it in batch
    const { createAgent: dbCreateAgent } = await import("../src/db/agents");
    const realAgent = dbCreateAgent({
      name: "BatchErrorAgent",
      model: "claude-sonnet-4-6",
      system: null,
      tools: [],
      mcp_servers: {},
      backend: "claude",
      webhook_url: null,
      threads_enabled: false,
    });
    const { handleBatch } = await import("../src/handlers/batch");
    const res = await handleBatch(
      req("/v1/batch", {
        body: {
          operations: [
            { method: "DELETE", path: `/v1/agents/${realAgent.id}` },
            { method: "DELETE", path: "/v1/agents/nonexistent-agent" },
          ],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { failed_operation_index: number; type: string } };
    expect(body.error.type).toBe("batch_error");
    expect(body.error.failed_operation_index).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("Settings", () => {
  beforeEach(() => freshDbEnv());

  it("settings write allowed key", async () => {
    await bootDb();
    const { handlePutSetting } = await import("../src/handlers/settings");
    const result = await callHandler<{ ok: boolean }>(
      handlePutSetting,
      "PUT",
      "/v1/settings",
      { key: "anthropic_api_key", value: "sk-ant-test" },
    );
    expect(result.ok).toBe(true);
  });

  it("settings write disallowed key returns 400", async () => {
    await bootDb();
    const { handlePutSetting } = await import("../src/handlers/settings");
    const res = await handlePutSetting(
      req("/v1/settings", { method: "PUT", body: { key: "not_a_real_setting", value: "val" } }),
    );
    expect(res.status).toBe(400);
  });

  it("settings value persists", async () => {
    await bootDb();
    const { handlePutSetting } = await import("../src/handlers/settings");
    await callHandler(
      handlePutSetting,
      "PUT",
      "/v1/settings",
      { key: "openai_api_key", value: "sk-openai-persist" },
    );
    const { invalidateConfigCache, getConfig } = await import("../src/config");
    invalidateConfigCache();
    const cfg = getConfig();
    // Config uses camelCase "openAiApiKey" (capital 'A')
    expect(cfg.openAiApiKey).toBe("sk-openai-persist");
  });
});

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

describe("Error Handling", () => {
  beforeEach(() => freshDbEnv());

  it("handler 404 causes callHandler to throw", async () => {
    await bootDb();
    const { handleGetAgent } = await import("../src/handlers/agents");
    await expect(
      callHandler(handleGetAgent, "GET", "/v1/agents/no-such-agent", undefined, "no-such-agent"),
    ).rejects.toThrow(/404|not.found/i);
  });

  it("handler 400 throws with message", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    await expect(
      callHandler(handleCreateAgent, "POST", "/v1/agents", { name: "", model: "claude-sonnet-4-6" }),
    ).rejects.toThrow();
  });

  it("handler 409 conflict error", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    await callHandler(handleCreateAgent, "POST", "/v1/agents", { name: "DuplicateAgent", model: "claude-sonnet-4-6" });
    await expect(
      callHandler(handleCreateAgent, "POST", "/v1/agents", { name: "DuplicateAgent", model: "claude-sonnet-4-6" }),
    ).rejects.toThrow(/409|conflict|already.exists/i);
  });

  it("auth required — no key returns 401", async () => {
    await bootDb();
    const { handleListAgents } = await import("../src/handlers/agents");
    const noAuthReq = new Request("http://localhost/v1/agents", {
      method: "GET",
      headers: { "content-type": "application/json" },
    });
    const res = await handleListAgents(noAuthReq);
    expect(res.status).toBe(401);
  });

  it("invalid JSON body results in non-2xx response", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const badReq = new Request("http://localhost/v1/agents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": TEST_API_KEY,
      },
      body: "{ not valid json !!!",
    });
    const res = await handleCreateAgent(badReq);
    // Invalid JSON causes an error response (4xx or 5xx)
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
