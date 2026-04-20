/**
 * Memory store agent scoping tests (v0.5).
 *
 * Covers:
 *   - Create requires agent_id (400 without)
 *   - Create validates agent exists (404 for fake id)
 *   - Cross-tenant memory store access returns 404
 *   - List filters by tenant
 *   - Memories CRUD respects store tenant
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-memory-scope-test-"));
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
    __caLicense?: unknown;
    __caDrizzle?: unknown;
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
  delete g.__caLicense;
  delete g.__caDrizzle;
}

async function bootTenants() {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { seedDefaultTenant, createTenant } = await import("../src/db/tenants");
  const { createApiKey } = await import("../src/db/api_keys");
  seedDefaultTenant();
  createTenant({ id: "tenant_acme", name: "acme" });

  const global = createApiKey({
    name: "global-admin",
    permissions: { admin: true, scope: null },
    tenantId: null,
    rawKey: "ck_test_global_mem_scope",
  });
  const acme = createApiKey({
    name: "acme-admin",
    permissions: { admin: true, scope: null },
    tenantId: "tenant_acme",
    rawKey: "ck_test_acme_mem_scope",
  });
  return { globalKey: global.key, acmeKey: acme.key };
}

function req(url: string, apiKey: string, opts: { method?: string; body?: unknown } = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("memory store agent scoping", () => {
  beforeEach(() => freshDbEnv());

  it("create without agent_id returns 400", async () => {
    const { globalKey } = await bootTenants();
    const { handleCreateMemoryStore } = await import("../src/handlers/memory");
    const res = await handleCreateMemoryStore(
      req("/v1/memory_stores", globalKey, { body: { name: "no-agent" } }),
    );
    expect(res.status).toBe(400);
  });

  it("create with non-existent agent_id returns 404", async () => {
    const { globalKey } = await bootTenants();
    const { handleCreateMemoryStore } = await import("../src/handlers/memory");
    const res = await handleCreateMemoryStore(
      req("/v1/memory_stores", globalKey, {
        body: { name: "bad-agent", agent_id: "agent_nonexistent" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("create with valid agent_id succeeds and stores agent_id", async () => {
    const { globalKey } = await bootTenants();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const { handleCreateMemoryStore } = await import("../src/handlers/memory");

    const agentRes = await handleCreateAgent(
      req("/v1/agents", globalKey, {
        body: { name: "mem-agent", model: "claude-sonnet-4-6" },
      }),
    );
    const agent = await agentRes.json() as { id: string };

    const res = await handleCreateMemoryStore(
      req("/v1/memory_stores", globalKey, {
        body: { name: "my-store", agent_id: agent.id },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { agent_id: string };
    expect(body.agent_id).toBe(agent.id);
  });

  it("cross-tenant memory store access returns 404", async () => {
    const { globalKey, acmeKey } = await bootTenants();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const { handleCreateMemoryStore, handleGetMemoryStore } = await import("../src/handlers/memory");

    // Global admin creates agent + store in default tenant
    const agentRes = await handleCreateAgent(
      req("/v1/agents", globalKey, {
        body: { name: "def-agent", model: "claude-sonnet-4-6", tenant_id: "tenant_default" },
      }),
    );
    const agent = await agentRes.json() as { id: string };
    const storeRes = await handleCreateMemoryStore(
      req("/v1/memory_stores", globalKey, {
        body: { name: "def-store", agent_id: agent.id },
      }),
    );
    const store = await storeRes.json() as { id: string };

    // Acme admin tries to access it → 404
    const getRes = await handleGetMemoryStore(
      req(`/v1/memory_stores/${store.id}`, acmeKey),
      store.id,
    );
    expect(getRes.status).toBe(404);
  });

  it("list filters by tenant", async () => {
    const { globalKey, acmeKey } = await bootTenants();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const { handleCreateMemoryStore, handleListMemoryStores } = await import("../src/handlers/memory");

    // Create agent + store in each tenant
    const defAgent = await (await handleCreateAgent(
      req("/v1/agents", globalKey, {
        body: { name: "def-a", model: "claude-sonnet-4-6", tenant_id: "tenant_default" },
      }),
    )).json() as { id: string };
    await handleCreateMemoryStore(
      req("/v1/memory_stores", globalKey, {
        body: { name: "def-store", agent_id: defAgent.id },
      }),
    );

    const acmeAgent = await (await handleCreateAgent(
      req("/v1/agents", acmeKey, {
        body: { name: "acme-a", model: "claude-sonnet-4-6" },
      }),
    )).json() as { id: string };
    await handleCreateMemoryStore(
      req("/v1/memory_stores", acmeKey, {
        body: { name: "acme-store", agent_id: acmeAgent.id },
      }),
    );

    // Global admin sees both
    const allRes = await (await handleListMemoryStores(
      req("/v1/memory_stores", globalKey),
    )).json() as { data: Array<{ name: string }> };
    expect(allRes.data.length).toBe(2);

    // Acme admin sees only their store
    const acmeRes = await (await handleListMemoryStores(
      req("/v1/memory_stores", acmeKey),
    )).json() as { data: Array<{ name: string }> };
    expect(acmeRes.data.length).toBe(1);
    expect(acmeRes.data[0].name).toBe("acme-store");
  });

  it("memories CRUD respects store tenant (cross-tenant → 404)", async () => {
    const { globalKey, acmeKey } = await bootTenants();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const { handleCreateMemoryStore, handleCreateMemory } = await import("../src/handlers/memory");

    const agent = await (await handleCreateAgent(
      req("/v1/agents", globalKey, {
        body: { name: "mem-a", model: "claude-sonnet-4-6", tenant_id: "tenant_default" },
      }),
    )).json() as { id: string };
    const store = await (await handleCreateMemoryStore(
      req("/v1/memory_stores", globalKey, {
        body: { name: "s", agent_id: agent.id },
      }),
    )).json() as { id: string };

    // Acme admin tries to create a memory in default's store → 404
    const res = await handleCreateMemory(
      req(`/v1/memory_stores/${store.id}/memories`, acmeKey, {
        body: { path: "/test", content: "hello" },
      }),
      store.id,
    );
    expect(res.status).toBe(404);
  });
});
