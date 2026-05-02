// @ts-nocheck — test file with loose typing on handler responses
/**
 * MA API spec-compliance tests.
 *
 * Verifies that the gateway matches the Anthropic Managed Agents API spec:
 *   - ID prefixes (agent_, sesn_, vlt_, cred_, memstore_)
 *   - Pagination shape (data, has_more, first_id, last_id — NOT next_page)
 *   - Error envelope ({type: "error", error: {type, message}})
 *   - Auth headers (x-api-key and Authorization: Bearer)
 *   - Agent CRUD fields
 *   - Session creation variants + required fields
 *   - Vaults + Credentials (static_bearer and mcp_oauth, token omission)
 *   - Events (post + list pagination)
 *   - Memory stores and memories
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure (copied verbatim from api-comprehensive.test.ts)
// ---------------------------------------------------------------------------

/** Wipe all globalThis singletons so next import gets a fresh DB. */
function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ma-compat-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.VAULT_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
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

// ---------------------------------------------------------------------------
// 1. ID Prefixes
// ---------------------------------------------------------------------------

describe("ID Prefixes", () => {
  beforeEach(() => freshDbEnv());

  it("agent ID starts with agent_", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(
      req("/v1/agents", { body: { name: "PrefixAgent", model: "claude-sonnet-4-6" } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe("string");
    expect((body.id as string).startsWith("agent_")).toBe(true);
  });

  it("session ID starts with sesn_", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "SesnPrefixAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { getDb } = await import("../src/db/client");
    const db = getDb();
    db.prepare(
      "INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES ('env_t', 't', '{}', 'ready', 'tenant_default', 0)",
    ).run();

    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(
      req("/v1/sessions", { body: { agent: agent.id, environment_id: "env_t" } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe("string");
    expect((body.id as string).startsWith("sesn_")).toBe(true);
  });

  it("vault ID starts with vlt_", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "VltPrefixAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { handleCreateVault } = await import("../src/handlers/vaults");
    const res = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "prefix-vault" } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe("string");
    expect((body.id as string).startsWith("vlt_")).toBe(true);
  });

  it("credential ID starts with cred_", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "CredPrefixAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { handleCreateVault } = await import("../src/handlers/vaults");
    const vaultRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "cred-vault" } }),
    );
    const vault = await vaultRes.json();

    const { handleCreateCredential } = await import("../src/handlers/credentials");
    const res = await handleCreateCredential(
      req(`/v1/vaults/${vault.id}/credentials`, {
        body: {
          display_name: "Cred Prefix Test",
          auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.com/mcp", token: "tok123" },
        },
      }),
      vault.id,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe("string");
    expect((body.id as string).startsWith("cred_")).toBe(true);
  });

  it("memory store ID starts with memstore_", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "MemstorePrefixAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { handleCreateMemoryStore } = await import("../src/handlers/memory");
    const res = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "prefix-store", agent_id: agent.id } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.id).toBe("string");
    expect((body.id as string).startsWith("memstore_")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Pagination Shape
// ---------------------------------------------------------------------------

describe("Pagination Shape", () => {
  beforeEach(() => freshDbEnv());

  it("list agents returns {data, has_more, first_id, last_id} — no next_page", async () => {
    await bootDb();
    const { handleCreateAgent, handleListAgents } = await import("../src/handlers/agents");
    await handleCreateAgent(req("/v1/agents", { body: { name: "Pag1", model: "claude-sonnet-4-6" } }));
    const res = await handleListAgents(req("/v1/agents"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.has_more).toBe("boolean");
    expect("first_id" in body).toBe(true);
    expect("last_id" in body).toBe(true);
    // spec says NOT next_page
    expect("next_page" in body).toBe(false);
  });

  it("has_more is true when more items exist beyond limit", async () => {
    await bootDb();
    const { handleCreateAgent, handleListAgents } = await import("../src/handlers/agents");
    await handleCreateAgent(req("/v1/agents", { body: { name: "HasMore1", model: "claude-sonnet-4-6" } }));
    await handleCreateAgent(req("/v1/agents", { body: { name: "HasMore2", model: "claude-sonnet-4-6" } }));
    const res = await handleListAgents(req("/v1/agents?limit=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.has_more).toBe(true);
    expect(body.first_id).toBeTruthy();
    expect(body.last_id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3. Error Envelope
// ---------------------------------------------------------------------------

describe("Error Envelope", () => {
  beforeEach(() => freshDbEnv());

  it("401 returns {type: 'error', error: {type: 'authentication_error', message}}", async () => {
    await bootDb();
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents", { apiKey: "" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("authentication_error");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("404 returns {type: 'error', error: {type: 'not_found_error', message}}", async () => {
    await bootDb();
    const { handleGetAgent } = await import("../src/handlers/agents");
    const res = await handleGetAgent(req("/v1/agents/agent_nonexistent"), "agent_nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("not_found_error");
    expect(typeof body.error.message).toBe("string");
  });

  it("400 returns {type: 'error', error: {type: 'invalid_request_error', message}}", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    // Missing required `model` field
    const res = await handleCreateAgent(req("/v1/agents", { body: { name: "NoModel" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("invalid_request_error");
    expect(typeof body.error.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 4. Auth
// ---------------------------------------------------------------------------

describe("Auth", () => {
  beforeEach(() => freshDbEnv());

  it("x-api-key header authenticates successfully (200)", async () => {
    await bootDb();
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents", { apiKey: "test-api-key-12345" }));
    expect(res.status).toBe(200);
  });

  it("Authorization: Bearer header authenticates successfully (200)", async () => {
    await bootDb();
    const { handleListAgents } = await import("../src/handlers/agents");
    const r = new Request("http://localhost/v1/agents", {
      method: "GET",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer test-api-key-12345",
      },
    });
    const res = await handleListAgents(r);
    expect(res.status).toBe(200);
  });

  it("missing key returns 401", async () => {
    await bootDb();
    const { handleListAgents } = await import("../src/handlers/agents");
    const res = await handleListAgents(req("/v1/agents", { apiKey: "" }));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 5. Agent CRUD
// ---------------------------------------------------------------------------

describe("Agent CRUD", () => {
  beforeEach(() => freshDbEnv());

  it("create returns version: 1 and archived_at absent (null in hydrate)", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const res = await handleCreateAgent(
      req("/v1/agents", { body: { name: "CrudAgent", model: "claude-sonnet-4-6" } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.version).toBe(1);
    expect(body.id).toBeTruthy();
    expect((body.id as string).startsWith("agent_")).toBe(true);
  });

  it("update with model change increments version", async () => {
    await bootDb();
    const { handleCreateAgent, handleUpdateAgent } = await import("../src/handlers/agents");
    const createRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "VersionAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await createRes.json();
    expect(agent.version).toBe(1);

    const updateRes = await handleUpdateAgent(
      req(`/v1/agents/${agent.id}`, { method: "PATCH", body: { model: "claude-opus-4-5" } }),
      agent.id,
    );
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.version).toBe(2);
  });

  it("list returns spec pagination shape with data array", async () => {
    await bootDb();
    const { handleCreateAgent, handleListAgents } = await import("../src/handlers/agents");
    await handleCreateAgent(req("/v1/agents", { body: { name: "ListA1", model: "claude-sonnet-4-6" } }));
    await handleCreateAgent(req("/v1/agents", { body: { name: "ListA2", model: "claude-sonnet-4-6" } }));
    const res = await handleListAgents(req("/v1/agents"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(2);
    expect(typeof body.has_more).toBe("boolean");
    expect("first_id" in body).toBe(true);
    expect("last_id" in body).toBe(true);
  });

  it("delete (archive) returns type: agent_deleted", async () => {
    await bootDb();
    const { handleCreateAgent, handleDeleteAgent } = await import("../src/handlers/agents");
    const createRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "DeleteAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await createRes.json();
    const res = await handleDeleteAgent(
      req(`/v1/agents/${agent.id}`, { method: "DELETE" }),
      agent.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("agent_deleted");
    expect(body.id).toBe(agent.id);
  });

  it("deleted agent is excluded from default list (archived)", async () => {
    await bootDb();
    const { handleCreateAgent, handleDeleteAgent, handleListAgents } = await import("../src/handlers/agents");
    const createRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "ArchiveCheck", model: "claude-sonnet-4-6" } }),
    );
    const agent = await createRes.json();
    await handleDeleteAgent(req(`/v1/agents/${agent.id}`, { method: "DELETE" }), agent.id);

    const res = await handleListAgents(req("/v1/agents"));
    const body = await res.json();
    const ids = body.data.map((a) => a.id);
    expect(ids).not.toContain(agent.id);

    // With include_archived=true it should appear
    const archivedRes = await handleListAgents(req("/v1/agents?include_archived=true"));
    const archivedBody = await archivedRes.json();
    const archivedIds = archivedBody.data.map((a) => a.id);
    expect(archivedIds).toContain(agent.id);
  });
});

// ---------------------------------------------------------------------------
// 6. Sessions
// ---------------------------------------------------------------------------

describe("Sessions", () => {
  beforeEach(() => freshDbEnv());

  it("create with string agent ID returns session with status: idle", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "SessStringAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { getDb } = await import("../src/db/client");
    const db = getDb();
    db.prepare(
      "INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES ('env_sess1', 'e1', '{}', 'ready', 'tenant_default', 0)",
    ).run();

    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(
      req("/v1/sessions", { body: { agent: agent.id, environment_id: "env_sess1" } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("idle");
    expect((body.id as string).startsWith("sesn_")).toBe(true);
  });

  it("create with {type: 'agent', id, version} object ref works", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "SessObjectAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { getDb } = await import("../src/db/client");
    const db = getDb();
    db.prepare(
      "INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES ('env_sess2', 'e2', '{}', 'ready', 'tenant_default', 0)",
    ).run();

    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(
      req("/v1/sessions", {
        body: { agent: { type: "agent", id: agent.id, version: 1 }, environment_id: "env_sess2" },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.id).toBe(agent.id);
    expect(body.agent.version).toBe(1);
  });

  it("session response has status: idle and usage object", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "SessFieldsAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { getDb } = await import("../src/db/client");
    const db = getDb();
    db.prepare(
      "INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES ('env_sess3', 'e3', '{}', 'ready', 'tenant_default', 0)",
    ).run();

    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(
      req("/v1/sessions", { body: { agent: agent.id, environment_id: "env_sess3" } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("idle");
    expect(body.usage).toBeDefined();
    expect(typeof body.usage).toBe("object");
  });

  it("delete session returns 200 with type: session_deleted", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "SessDelAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { getDb } = await import("../src/db/client");
    const db = getDb();
    db.prepare(
      "INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES ('env_sess4', 'e4', '{}', 'ready', 'tenant_default', 0)",
    ).run();

    const { handleCreateSession } = await import("../src/handlers/sessions");
    const sessRes = await handleCreateSession(
      req("/v1/sessions", { body: { agent: agent.id, environment_id: "env_sess4" } }),
    );
    const sess = await sessRes.json();

    const { handleDeleteSession } = await import("../src/handlers/sessions");
    const res = await handleDeleteSession(
      req(`/v1/sessions/${sess.id}`, { method: "DELETE" }),
      sess.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("session_deleted");
  });
});

// ---------------------------------------------------------------------------
// 7. Vaults + Credentials
// ---------------------------------------------------------------------------

describe("Vaults + Credentials", () => {
  beforeEach(() => freshDbEnv());

  it("create vault returns type: vault and display_name field", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "VaultTypeAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { handleCreateVault } = await import("../src/handlers/vaults");
    const res = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "spec-vault" } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect((body.id as string).startsWith("vlt_")).toBe(true);
    // display_name is an alias for name
    expect(body.display_name).toBe("spec-vault");
  });

  it("create static_bearer credential — GET does not return token", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "CredNoTokenAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { handleCreateVault } = await import("../src/handlers/vaults");
    const vaultRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "cred-vault" } }),
    );
    const vault = await vaultRes.json();

    const { handleCreateCredential, handleGetCredential } = await import("../src/handlers/credentials");
    const createRes = await handleCreateCredential(
      req(`/v1/vaults/${vault.id}/credentials`, {
        body: {
          display_name: "Static Bearer Cred",
          auth: {
            type: "static_bearer",
            mcp_server_url: "https://mcp.example.com/mcp",
            token: "supersecrettoken123",
          },
        },
      }),
      vault.id,
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    // Create response must not contain the token
    expect(JSON.stringify(created)).not.toContain("supersecrettoken123");
    expect((created.auth as Record<string, unknown>).token).toBeUndefined();

    // GET response also must not contain the token
    const getRes = await handleGetCredential(
      req(`/v1/vaults/${vault.id}/credentials/${created.id}`),
      vault.id,
      created.id,
    );
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(JSON.stringify(fetched)).not.toContain("supersecrettoken123");
    expect((fetched.auth as Record<string, unknown>).token).toBeUndefined();
  });

  it("create mcp_oauth credential — GET does not return access_token or refresh_token", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "OAuthNoSecretAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { handleCreateVault } = await import("../src/handlers/vaults");
    const vaultRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "oauth-vault" } }),
    );
    const vault = await vaultRes.json();

    const { handleCreateCredential, handleGetCredential } = await import("../src/handlers/credentials");
    const createRes = await handleCreateCredential(
      req(`/v1/vaults/${vault.id}/credentials`, {
        body: {
          display_name: "OAuth Cred",
          auth: {
            type: "mcp_oauth",
            mcp_server_url: "https://mcp.oauth-test.com",
            access_token: "my_access_token_secret",
            expires_at: "2027-01-01T00:00:00Z",
            refresh: {
              token_endpoint: "https://auth.oauth-test.com/token",
              client_id: "client_123",
              refresh_token: "my_refresh_token_secret",
            },
          },
        },
      }),
      vault.id,
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    // Create response must not expose secrets
    const createJson = JSON.stringify(created);
    expect(createJson).not.toContain("my_access_token_secret");
    expect(createJson).not.toContain("my_refresh_token_secret");
    expect((created.auth as Record<string, unknown>).access_token).toBeUndefined();
    expect((created.auth as Record<string, unknown>).refresh).toBeUndefined();

    // GET response also must not expose secrets
    const getRes = await handleGetCredential(
      req(`/v1/vaults/${vault.id}/credentials/${created.id}`),
      vault.id,
      created.id,
    );
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    const fetchJson = JSON.stringify(fetched);
    expect(fetchJson).not.toContain("my_access_token_secret");
    expect(fetchJson).not.toContain("my_refresh_token_secret");
    expect((fetched.auth as Record<string, unknown>).access_token).toBeUndefined();
    expect((fetched.auth as Record<string, unknown>).refresh).toBeUndefined();
  });

  it("409 on duplicate display_name within same vault", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "DupeCredAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { handleCreateVault } = await import("../src/handlers/vaults");
    const vaultRes = await handleCreateVault(
      req("/v1/vaults", { body: { agent_id: agent.id, name: "dupe-cred-vault" } }),
    );
    const vault = await vaultRes.json();

    const { handleCreateCredential } = await import("../src/handlers/credentials");
    const firstRes = await handleCreateCredential(
      req(`/v1/vaults/${vault.id}/credentials`, {
        body: {
          display_name: "Same Name",
          auth: { type: "static_bearer", mcp_server_url: "https://mcp.first.com/mcp", token: "tok1" },
        },
      }),
      vault.id,
    );
    expect(firstRes.status).toBe(201);

    // Same display_name in same vault -> 409
    const secondRes = await handleCreateCredential(
      req(`/v1/vaults/${vault.id}/credentials`, {
        body: {
          display_name: "Same Name",
          auth: { type: "static_bearer", mcp_server_url: "https://mcp.second.com/mcp", token: "tok2" },
        },
      }),
      vault.id,
    );
    expect(secondRes.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 8. Events
// ---------------------------------------------------------------------------

describe("Events", () => {
  beforeEach(() => freshDbEnv());

  /** Helper: set up agent + env + session. */
  async function makeSession(): Promise<string> {
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: `EvtAgent-${Date.now()}`, model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const db = getDb();
    const envId = newId("env");
    db.prepare(
      "INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, 'e', '{}', 'ready', 'tenant_default', 0)",
    ).run(envId);

    const { handleCreateSession } = await import("../src/handlers/sessions");
    const sessRes = await handleCreateSession(
      req("/v1/sessions", { body: { agent: agent.id, environment_id: envId } }),
    );
    const sess = await sessRes.json();
    return sess.id as string;
  }

  it("POST user.message event returns 200", async () => {
    await bootDb();
    const sessionId = await makeSession();

    const { handlePostEvents } = await import("../src/handlers/events");
    const res = await handlePostEvents(
      req(`/v1/sessions/${sessionId}/events`, {
        body: { events: [{ type: "user.message", content: [{ type: "text", text: "Hello" }] }] },
      }),
      sessionId,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].type).toBe("user.message");
  });

  it("events list returns spec pagination shape", async () => {
    await bootDb();
    const sessionId = await makeSession();

    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");
    await handlePostEvents(
      req(`/v1/sessions/${sessionId}/events`, {
        body: { events: [{ type: "user.message", content: [{ type: "text", text: "Msg1" }] }] },
      }),
      sessionId,
    );
    await handlePostEvents(
      req(`/v1/sessions/${sessionId}/events`, {
        body: { events: [{ type: "user.message", content: [{ type: "text", text: "Msg2" }] }] },
      }),
      sessionId,
    );

    const res = await handleListEvents(req(`/v1/sessions/${sessionId}/events`), sessionId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    // Pagination fields
    expect(typeof body.has_more).toBe("boolean");
    expect("first_id" in body).toBe(true);
    expect("last_id" in body).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Memory
// ---------------------------------------------------------------------------

describe("Memory", () => {
  beforeEach(() => freshDbEnv());

  it("create memory store returns correct fields (id, name, agent_id)", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "MemTypeAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { handleCreateMemoryStore } = await import("../src/handlers/memory");
    const res = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "type-store", agent_id: agent.id } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect((body.id as string).startsWith("memstore_")).toBe(true);
    expect(body.name).toBe("type-store");
    expect(body.agent_id).toBe(agent.id);
    expect(body.created_at).toBeDefined();
    expect(body.updated_at).toBeDefined();
  });

  it("create memory with path + content returns content_sha256", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", { body: { name: "MemShaAgent", model: "claude-sonnet-4-6" } }),
    );
    const agent = await agentRes.json();

    const { handleCreateMemoryStore, handleCreateMemory } = await import("../src/handlers/memory");
    const storeRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", { body: { name: "sha-store", agent_id: agent.id } }),
    );
    const store = await storeRes.json();

    const res = await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, {
        body: { path: "/docs/spec.md", content: "Spec content here" },
      }),
      store.id,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.path).toBe("/docs/spec.md");
    expect(body.content).toBe("Spec content here");
    expect(typeof body.content_sha256).toBe("string");
    expect(body.content_sha256.length).toBeGreaterThan(0);
  });
});
