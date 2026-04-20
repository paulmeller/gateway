/**
 * v0.5 PR4c — audit log.
 *
 * Covers:
 *   - recordAudit writes and survives DB errors
 *   - listAudit tenant filter + per-action filters
 *   - handleListAudit is admin-only
 *   - tenant admin sees only their tenant's entries
 *   - creating a tenant / revoking a key leaves an audit trail
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-audit-test-"));
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
    __caRateLimitBuckets?: unknown;
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
  delete g.__caRateLimitBuckets;
}

async function bootTenants(): Promise<{
  globalKey: string;
  globalId: string;
  acmeKey: string;
  acmeId: string;
}> {
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
    rawKey: "ck_test_global_admin_audit",
  });
  const acme = createApiKey({
    name: "acme-admin",
    permissions: { admin: true, scope: null },
    tenantId: "tenant_acme",
    rawKey: "ck_test_acme_admin_audit",
  });
  return {
    globalKey: global.key,
    globalId: global.id,
    acmeKey: acme.key,
    acmeId: acme.id,
  };
}

function req(url: string, apiKey: string, opts: { method?: string; body?: unknown } = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("audit log — db layer", () => {
  beforeEach(() => freshDbEnv());

  it("recordAudit persists entries with actor + tenant context", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    const { recordAudit, listAudit } = await import("../src/db/audit");
    const auth = {
      keyId: "key_test",
      name: "test-admin",
      permissions: { admin: true, scope: null as null | import("../src/types").KeyScope },
      tenantId: "tenant_default",
      isGlobalAdmin: false,
      budgetUsd: null,
      rateLimitRpm: null,
      spentUsd: 0,
    };
    recordAudit({ auth, action: "tenants.create", resource_type: "tenant", resource_id: "tenant_abc" });

    const rows = listAudit({ tenantFilter: "tenant_default" });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("tenants.create");
    expect(rows[0].actor_key_id).toBe("key_test");
    expect(rows[0].actor_name).toBe("test-admin");
    expect(rows[0].tenant_id).toBe("tenant_default");
    expect(rows[0].resource_type).toBe("tenant");
    expect(rows[0].resource_id).toBe("tenant_abc");
    expect(rows[0].outcome).toBe("success");
  });

  it("listAudit supports action / actor / outcome / time filters", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    const { recordAudit, listAudit } = await import("../src/db/audit");
    const mkAuth = (keyId: string, tenantId: string | null) => ({
      keyId, name: keyId, permissions: { admin: true, scope: null },
      tenantId, isGlobalAdmin: tenantId === null,
      budgetUsd: null, rateLimitRpm: null, spentUsd: 0,
    });
    recordAudit({ auth: mkAuth("k1", "tenant_default"), action: "api_keys.create" });
    recordAudit({ auth: mkAuth("k2", "tenant_default"), action: "api_keys.revoke", outcome: "success" });
    recordAudit({ auth: mkAuth("k1", "tenant_default"), action: "api_keys.revoke", outcome: "denied" });

    const revokes = listAudit({ action: "api_keys.revoke" });
    expect(revokes).toHaveLength(2);

    const denied = listAudit({ outcome: "denied" });
    expect(denied).toHaveLength(1);
    expect(denied[0].actor_key_id).toBe("k1");

    const byActor = listAudit({ actor_key_id: "k2" });
    expect(byActor).toHaveLength(1);
    expect(byActor[0].action).toBe("api_keys.revoke");
  });

  it("listAudit respects tenantFilter (cross-tenant isolation)", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    const { recordAudit, listAudit } = await import("../src/db/audit");
    const mkAuth = (tenantId: string | null) => ({
      keyId: "k", name: "k", permissions: { admin: true, scope: null },
      tenantId, isGlobalAdmin: tenantId === null,
      budgetUsd: null, rateLimitRpm: null, spentUsd: 0,
    });
    recordAudit({ auth: mkAuth("tenant_default"), action: "a" });
    recordAudit({ auth: mkAuth("tenant_acme"),    action: "b" });
    recordAudit({ auth: mkAuth("tenant_default"), action: "c" });

    const defaultOnly = listAudit({ tenantFilter: "tenant_default" });
    expect(defaultOnly.map(r => r.action).sort()).toEqual(["a", "c"]);

    const acmeOnly = listAudit({ tenantFilter: "tenant_acme" });
    expect(acmeOnly.map(r => r.action)).toEqual(["b"]);

    // null = no filter (global admin view).
    const all = listAudit({ tenantFilter: null });
    expect(all).toHaveLength(3);
  });

  it("recordAudit swallows DB errors instead of throwing", async () => {
    // Close the DB before writing — recordAudit should log and return
    // cleanly rather than propagate.
    const { getDb, closeDb } = await import("../src/db/client");
    getDb();
    closeDb();
    const { recordAudit } = await import("../src/db/audit");
    expect(() => recordAudit({ auth: null, action: "test.thing" })).not.toThrow();
  });
});

describe("GET /v1/audit-log handler", () => {
  beforeEach(() => freshDbEnv());

  it("non-admin gets 403", async () => {
    await bootTenants();
    const { createApiKey } = await import("../src/db/api_keys");
    const { handleListAudit } = await import("../src/handlers/audit");
    const { key } = createApiKey({
      name: "user",
      permissions: { admin: false, scope: null },
      tenantId: "tenant_default",
      rawKey: "ck_test_useraudit_12345678",
    });
    const res = await handleListAudit(req("/v1/audit-log", key));
    expect(res.status).toBe(403);
  });

  it("tenant admin sees only entries for their tenant", async () => {
    const { globalKey, acmeKey } = await bootTenants();

    // Generate a couple of actions in each tenant by hitting the
    // tenant-create path (which audits) as the global admin.
    const { handleCreateTenant } = await import("../src/handlers/tenants");
    await handleCreateTenant(req("/v1/tenants", globalKey, {
      body: { name: "new1", id: "tenant_new1" },
    }));
    await handleCreateTenant(req("/v1/tenants", globalKey, {
      body: { name: "new2", id: "tenant_new2" },
    }));

    // And an action in the acme tenant (e.g. creating a key).
    const { handleCreateApiKey } = await import("../src/handlers/api_keys");
    await handleCreateApiKey(req("/v1/api-keys", acmeKey, {
      body: { name: "scoped", permissions: { admin: false, scope: null } },
    }));

    const { handleListAudit } = await import("../src/handlers/audit");

    // Global admin sees everything.
    const allRes = await handleListAudit(req("/v1/audit-log", globalKey));
    expect(allRes.status).toBe(200);
    const all = await allRes.json() as { data: Array<{ action: string; tenant_id: string | null }> };
    expect(all.data.length).toBeGreaterThanOrEqual(3);

    // Acme admin sees only acme-scoped entries.
    const acmeRes = await handleListAudit(req("/v1/audit-log", acmeKey));
    expect(acmeRes.status).toBe(200);
    const acme = await acmeRes.json() as { data: Array<{ tenant_id: string | null }> };
    expect(acme.data.length).toBeGreaterThan(0);
    for (const row of acme.data) expect(row.tenant_id).toBe("tenant_acme");
  });
});
