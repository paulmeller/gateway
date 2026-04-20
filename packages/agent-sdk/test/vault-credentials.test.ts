// @ts-nocheck — test file with loose typing on handler responses
/**
 * Vault credentials (Anthropic-compatible) API tests.
 *
 * Tests the full credentials surface: CRUD, tenant isolation, token
 * omission in responses, and the loadSessionSecrets() integration that
 * derives MCP_AUTH_* keys from credential mcp_server_urls.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-cred-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.VAULT_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
    __caDrizzle?: unknown;
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
  const { key } = createApiKey({
    name: "test",
    permissions: ["*"],
    rawKey: "test-api-key-12345",
  });
  return key;
}

function req(
  url: string,
  opts: {
    method?: string;
    body?: unknown;
    apiKey?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  headers["x-api-key"] = opts.apiKey ?? "test-api-key-12345";
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function createTestAgent(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { handleCreateAgent } = await import("../src/handlers/agents");
  const res = await handleCreateAgent(
    req("/v1/agents", {
      body: {
        name: `Agent-${Date.now()}-${Math.random()}`,
        model: "claude-sonnet-4-6",
        ...overrides,
      },
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

async function createTestVault(
  agentId: string,
  name = "test-vault",
): Promise<Record<string, unknown>> {
  const { handleCreateVault } = await import("../src/handlers/vaults");
  const res = await handleCreateVault(
    req("/v1/vaults", { body: { agent_id: agentId, name } }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("vault credentials API", () => {
  beforeEach(() => freshDbEnv());

  it("creates credential -> 201, returns vcrd_ id, display_name, auth shape, NO token", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleCreateCredential } = await import(
      "../src/handlers/credentials"
    );
    const res = await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "GitHub Token",
          auth: { type: "static_bearer", token: "ghp_abc123secret" },
        },
      }),
      vaultId,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.id).toBeDefined();
    expect((body.id as string).startsWith("vcrd_")).toBe(true);
    expect(body.display_name).toBe("GitHub Token");
    expect(body.vault_id).toBe(vaultId);
    expect((body.auth as Record<string, unknown>).type).toBe("static_bearer");
    // Token MUST NOT appear in response
    expect((body.auth as Record<string, unknown>).token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("ghp_abc123secret");
    expect(body.created_at).toBeDefined();
    expect(body.updated_at).toBeDefined();
  });

  it("creates credential with mcp_server_url", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleCreateCredential } = await import(
      "../src/handlers/credentials"
    );
    const res = await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "GitHub MCP",
          auth: {
            type: "static_bearer",
            token: "ghp_mcp_token",
            mcp_server_url: "https://mcp.github.com",
          },
        },
      }),
      vaultId,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.auth as Record<string, unknown>).mcp_server_url).toBe(
      "https://mcp.github.com",
    );
  });

  it("create with duplicate display_name -> 409", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleCreateCredential } = await import(
      "../src/handlers/credentials"
    );
    await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "dup-name",
          auth: { type: "static_bearer", token: "tok1" },
        },
      }),
      vaultId,
    );
    const res = await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "dup-name",
          auth: { type: "static_bearer", token: "tok2" },
        },
      }),
      vaultId,
    );
    expect(res.status).toBe(409);
  });

  it("create with invalid auth type -> 400", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleCreateCredential } = await import(
      "../src/handlers/credentials"
    );
    const res = await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "bad-type",
          auth: { type: "oauth2", token: "tok" },
        },
      }),
      vaultId,
    );
    expect(res.status).toBe(400);
  });

  it("create without display_name -> 400", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleCreateCredential } = await import(
      "../src/handlers/credentials"
    );
    const res = await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          auth: { type: "static_bearer", token: "tok" },
        },
      }),
      vaultId,
    );
    expect(res.status).toBe(400);
  });

  it("list credentials -> returns array, no tokens", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleCreateCredential, handleListCredentials } = await import(
      "../src/handlers/credentials"
    );
    await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "cred-a",
          auth: { type: "static_bearer", token: "secret-a" },
        },
      }),
      vaultId,
    );
    await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "cred-b",
          auth: { type: "static_bearer", token: "secret-b" },
        },
      }),
      vaultId,
    );

    const res = await handleListCredentials(
      req(`/v1/vaults/${vaultId}/credentials`),
      vaultId,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(2);
    // No tokens anywhere in the response
    const json = JSON.stringify(body);
    expect(json).not.toContain("secret-a");
    expect(json).not.toContain("secret-b");
  });

  it("get credential by id -> returns credential, no token", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleCreateCredential, handleGetCredential } = await import(
      "../src/handlers/credentials"
    );
    const createRes = await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "get-test",
          auth: { type: "static_bearer", token: "get-secret" },
        },
      }),
      vaultId,
    );
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await handleGetCredential(
      req(`/v1/vaults/${vaultId}/credentials/${created.id}`),
      vaultId,
      created.id as string,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(created.id);
    expect(body.display_name).toBe("get-test");
    expect(JSON.stringify(body)).not.toContain("get-secret");
  });

  it("get non-existent credential -> 404", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleGetCredential } = await import(
      "../src/handlers/credentials"
    );
    const res = await handleGetCredential(
      req(`/v1/vaults/${vaultId}/credentials/vcrd_nonexistent`),
      vaultId,
      "vcrd_nonexistent",
    );
    expect(res.status).toBe(404);
  });

  it("update credential (change display_name) -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleCreateCredential, handleUpdateCredential } = await import(
      "../src/handlers/credentials"
    );
    const createRes = await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "old-name",
          auth: { type: "static_bearer", token: "tok" },
        },
      }),
      vaultId,
    );
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await handleUpdateCredential(
      req(`/v1/vaults/${vaultId}/credentials/${created.id}`, {
        body: { display_name: "new-name" },
      }),
      vaultId,
      created.id as string,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.display_name).toBe("new-name");
  });

  it("update credential (rotate token) -> 200, token not in response", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleCreateCredential, handleUpdateCredential } = await import(
      "../src/handlers/credentials"
    );
    const createRes = await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "rotate-test",
          auth: { type: "static_bearer", token: "old-token" },
        },
      }),
      vaultId,
    );
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await handleUpdateCredential(
      req(`/v1/vaults/${vaultId}/credentials/${created.id}`, {
        body: { auth: { token: "new-rotated-token" } },
      }),
      vaultId,
      created.id as string,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const json = JSON.stringify(body);
    expect(json).not.toContain("old-token");
    expect(json).not.toContain("new-rotated-token");

    // Verify the token was actually rotated via DB layer
    const { getCredentialToken } = await import("../src/db/credentials");
    expect(getCredentialToken(created.id as string)).toBe("new-rotated-token");
  });

  it("delete credential -> 200", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleCreateCredential, handleDeleteCredential, handleGetCredential } =
      await import("../src/handlers/credentials");
    const createRes = await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "to-delete",
          auth: { type: "static_bearer", token: "tok" },
        },
      }),
      vaultId,
    );
    const created = (await createRes.json()) as Record<string, unknown>;

    const res = await handleDeleteCredential(
      req(`/v1/vaults/${vaultId}/credentials/${created.id}`, {
        method: "DELETE",
      }),
      vaultId,
      created.id as string,
    );
    expect(res.status).toBe(200);

    // Verify it's gone
    const getRes = await handleGetCredential(
      req(`/v1/vaults/${vaultId}/credentials/${created.id}`),
      vaultId,
      created.id as string,
    );
    expect(getRes.status).toBe(404);
  });

  it("delete non-existent credential -> 404", async () => {
    await bootDb();
    const agent = await createTestAgent();
    const vault = await createTestVault(agent.id as string);
    const vaultId = vault.id as string;

    const { handleDeleteCredential } = await import(
      "../src/handlers/credentials"
    );
    const res = await handleDeleteCredential(
      req(`/v1/vaults/${vaultId}/credentials/vcrd_nonexistent`, {
        method: "DELETE",
      }),
      vaultId,
      "vcrd_nonexistent",
    );
    expect(res.status).toBe(404);
  });

  it("cross-tenant access -> 404", async () => {
    // Boot with tenant infrastructure
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-cred-tenant-test-"));
    process.env.DATABASE_PATH = path.join(dir, "test.db");
    const g = globalThis as typeof globalThis & {
      __caDb?: unknown;
      __caInitialized?: unknown;
      __caInitPromise?: unknown;
      __caBusEmitters?: unknown;
      __caConfigCache?: unknown;
      __caRuntime?: unknown;
      __caSweeperHandle?: unknown;
      __caActors?: unknown;
    };
    delete g.__caDb;
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

    const { getDb } = await import("../src/db/client");
    getDb();
    const { seedDefaultTenant, createTenant } = await import(
      "../src/db/tenants"
    );
    const { createApiKey } = await import("../src/db/api_keys");

    seedDefaultTenant();
    createTenant({ id: "tenant_acme", name: "acme" });

    // Global admin key
    const global = createApiKey({
      name: "global-admin",
      permissions: { admin: true, scope: null },
      tenantId: null,
      rawKey: "ck_test_global_admin_001",
    });

    // Acme tenant key
    const acme = createApiKey({
      name: "acme-admin",
      permissions: { admin: true, scope: null },
      tenantId: "tenant_acme",
      rawKey: "ck_test_acme_admin_001",
    });

    // Create agent + vault in default tenant (via global admin)
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const agentRes = await handleCreateAgent(
      req("/v1/agents", {
        body: {
          name: "def-agent",
          model: "claude-sonnet-4-6",
          tenant_id: "tenant_default",
        },
        apiKey: global.key,
      }),
    );
    const agent = (await agentRes.json()) as Record<string, unknown>;

    const { handleCreateVault } = await import("../src/handlers/vaults");
    const vaultRes = await handleCreateVault(
      req("/v1/vaults", {
        body: { agent_id: agent.id, name: "def-vault" },
        apiKey: global.key,
      }),
    );
    const vault = (await vaultRes.json()) as Record<string, unknown>;
    const vaultId = vault.id as string;

    // Create credential in default tenant vault (as global admin)
    const { handleCreateCredential, handleGetCredential, handleListCredentials } =
      await import("../src/handlers/credentials");
    const credRes = await handleCreateCredential(
      req(`/v1/vaults/${vaultId}/credentials`, {
        body: {
          display_name: "secret-cred",
          auth: { type: "static_bearer", token: "top-secret" },
        },
        apiKey: global.key,
      }),
      vaultId,
    );
    expect(credRes.status).toBe(201);
    const cred = (await credRes.json()) as Record<string, unknown>;

    // Acme tenant tries to read the credential -> 404 (vault tenant mismatch)
    const getRes = await handleGetCredential(
      req(`/v1/vaults/${vaultId}/credentials/${cred.id}`, {
        apiKey: acme.key,
      }),
      vaultId,
      cred.id as string,
    );
    expect(getRes.status).toBe(404);

    // Acme tenant tries to list credentials -> 404 (vault not found for caller)
    const listRes = await handleListCredentials(
      req(`/v1/vaults/${vaultId}/credentials`, {
        apiKey: acme.key,
      }),
      vaultId,
    );
    expect(listRes.status).toBe(404);
  });
});

describe("loadSessionSecrets() with credentials", () => {
  beforeEach(() => freshDbEnv());

  it("credentials appear with correct MCP_AUTH_* key derivation", async () => {
    await bootDb();
    const agent = await createTestAgent();

    // Create vault via DB layer directly
    const { createVault, setEntry } = await import("../src/db/vaults");
    const vault = createVault({
      agent_id: agent.id as string,
      name: "secrets",
    });

    // Add a regular vault entry
    setEntry(vault.id, "MY_SECRET", "regular-value");

    // Add credentials via DB layer
    const { createCredential } = await import("../src/db/credentials");
    createCredential({
      vault_id: vault.id,
      display_name: "GitHub MCP",
      auth_type: "static_bearer",
      token: "ghp_mcp_token_123",
      mcp_server_url: "https://mcp.github.com",
    });
    createCredential({
      vault_id: vault.id,
      display_name: "Plain Token",
      auth_type: "static_bearer",
      token: "plain-secret-456",
    });

    // Load session secrets
    const { loadSessionSecrets } = await import("../src/sessions/secrets");
    const secrets = loadSessionSecrets([vault.id]);

    // Should contain the regular vault entry
    const mySecret = secrets.find((s) => s.key === "MY_SECRET");
    expect(mySecret).toBeDefined();
    expect(mySecret!.value).toBe("regular-value");

    // Should contain MCP_AUTH_GITHUB from the mcp_server_url credential
    const mcpAuth = secrets.find((s) => s.key === "MCP_AUTH_GITHUB");
    expect(mcpAuth).toBeDefined();
    expect(mcpAuth!.value).toBe("ghp_mcp_token_123");

    // Should contain CREDENTIAL_GITHUB_MCP for the first credential
    const credGithub = secrets.find((s) => s.key === "CREDENTIAL_GITHUB_MCP");
    expect(credGithub).toBeDefined();
    expect(credGithub!.value).toBe("ghp_mcp_token_123");

    // Should contain CREDENTIAL_PLAIN_TOKEN for the second credential
    const credPlain = secrets.find((s) => s.key === "CREDENTIAL_PLAIN_TOKEN");
    expect(credPlain).toBeDefined();
    expect(credPlain!.value).toBe("plain-secret-456");
  });

  it("deriveServerName handles various URL patterns", async () => {
    const { deriveServerName } = await import("../src/sessions/secrets");

    expect(deriveServerName("https://mcp.github.com")).toBe("github");
    expect(deriveServerName("https://api.xero.com/mcp")).toBe("xero");
    expect(deriveServerName("https://www.example.io")).toBe("example");
    expect(deriveServerName("https://custom-server.dev")).toBe("custom-server");
    expect(deriveServerName("not-a-url")).toBeNull();
  });
});
