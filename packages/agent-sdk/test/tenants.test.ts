/**
 * Tests for the v0.5 tenancy primitives: schema migration, db/tenants.ts
 * CRUD, auth/scope.ts helpers, and the `default` tenant seed.
 *
 * Handler-level filter injection tests live in tenancy-enforcement.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-tenants-test-"));
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

describe("db/tenants.ts", () => {
  beforeEach(() => freshDbEnv());

  it("seedDefaultTenant creates tenant_default once; idempotent", async () => {
    const { getDb } = await import("../src/db/client");
    const { seedDefaultTenant, listTenants, DEFAULT_TENANT_ID } = await import("../src/db/tenants");
    getDb();
    seedDefaultTenant();
    seedDefaultTenant(); // second call is no-op
    const all = listTenants();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(DEFAULT_TENANT_ID);
    expect(all[0].name).toBe("default");
  });

  it("createTenant + getTenant + renameTenant round-trip", async () => {
    const { getDb } = await import("../src/db/client");
    const { createTenant, getTenant, renameTenant } = await import("../src/db/tenants");
    getDb();
    const t = createTenant({ name: "acme" });
    expect(t.id).toMatch(/^tenant_/);
    expect(getTenant(t.id)?.name).toBe("acme");
    expect(renameTenant(t.id, "acme-corp")).toBe(true);
    expect(getTenant(t.id)?.name).toBe("acme-corp");
    expect(renameTenant("tenant_does_not_exist", "x")).toBe(false);
  });

  it("archiveTenant soft-deletes; refuses the default tenant", async () => {
    const { getDb } = await import("../src/db/client");
    const {
      seedDefaultTenant, createTenant, archiveTenant, listTenants, DEFAULT_TENANT_ID,
    } = await import("../src/db/tenants");
    getDb();
    seedDefaultTenant();
    const t = createTenant({ name: "temp" });

    // Archive the custom tenant → hidden by default list
    expect(archiveTenant(t.id)).toBe(true);
    const active = listTenants();
    expect(active.map(r => r.id)).not.toContain(t.id);
    const all = listTenants({ includeArchived: true });
    expect(all.map(r => r.id)).toContain(t.id);

    // Refuse to archive the default
    expect(archiveTenant(DEFAULT_TENANT_ID)).toBe(false);
    expect(listTenants().some(r => r.id === DEFAULT_TENANT_ID)).toBe(true);
  });
});

describe("assignNullRowsToTenant (migrate-legacy semantics)", () => {
  beforeEach(() => freshDbEnv());

  it("bulk-moves null-tenant rows to the target; leaves already-tenanted rows alone; leaves api_keys alone", async () => {
    const { getDb } = await import("../src/db/client");
    const { createAgent } = await import("../src/db/agents");
    const { createApiKey } = await import("../src/db/api_keys");
    const { seedDefaultTenant, createTenant, assignNullRowsToTenant, countNullTenantRows, DEFAULT_TENANT_ID } = await import("../src/db/tenants");
    const { newId } = await import("../src/util/ids");

    const db = getDb();
    seedDefaultTenant();
    const t2 = createTenant({ name: "other" });

    // Pre-0.5 style rows: all tenant_id = NULL. Use raw SQL because
    // createAgent() now defaults tenant_id to DEFAULT_TENANT_ID via ??.
    const agentId = newId("agent");
    const now = Date.now();
    db.prepare(
      `INSERT INTO agents (id, current_version, name, tenant_id, created_at, updated_at) VALUES (?, 1, ?, NULL, ?, ?)`,
    ).run(agentId, "legacy-agent", now, now);
    db.prepare(
      `INSERT INTO agent_versions (agent_id, version, model, tools_json, mcp_servers_json, created_at) VALUES (?, 1, ?, '[]', '{}', ?)`,
    ).run(agentId, "claude-sonnet-4-6", now);
    const agent = { id: agentId };
    const envId = newId("env");
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, created_at) VALUES (?, ?, ?, 'ready', ?)`,
    ).run(envId, "legacy-env", "{}", Date.now());
    const sessId = newId("sess");
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, created_at, updated_at) VALUES (?, ?, 1, ?, 'idle', '{}', ?, ?)`,
    ).run(sessId, agent.id, envId, Date.now(), Date.now());

    // Also a pre-5 api_key (null tenant). Should NOT be migrated.
    createApiKey({
      name: "legacy-key",
      permissions: { admin: true, scope: null },
      rawKey: "ck_legacy_key_test_1234567890",
    });

    // And a row already tenanted to t2 — must not be disturbed.
    const preTenanted = createAgent({ name: "already-t2", model: "claude-sonnet-4-6" });
    db.prepare(`UPDATE agents SET tenant_id = ? WHERE id = ?`).run(t2.id, preTenanted.id);

    const before = countNullTenantRows();
    expect(before.agents).toBeGreaterThan(0);
    expect(before.api_keys).toBeGreaterThan(0);

    const result = assignNullRowsToTenant(DEFAULT_TENANT_ID);
    expect(result.agents).toBeGreaterThan(0);
    expect(result.environments).toBeGreaterThan(0);
    expect(result.sessions).toBeGreaterThan(0);

    const after = countNullTenantRows();
    expect(after.agents).toBe(0);
    expect(after.environments).toBe(0);
    expect(after.sessions).toBe(0);
    // api_keys unchanged
    expect(after.api_keys).toBe(before.api_keys);

    // The pre-tenanted t2 row is still in t2.
    const unchangedRow = db.prepare(`SELECT tenant_id FROM agents WHERE id = ?`).get(preTenanted.id) as { tenant_id: string };
    expect(unchangedRow.tenant_id).toBe(t2.id);
  });
});

describe("AuthContext isGlobalAdmin", () => {
  beforeEach(() => freshDbEnv());

  it("legacy [\"*\"] key with null tenant is a global admin", async () => {
    const { getDb } = await import("../src/db/client");
    const { createApiKey } = await import("../src/db/api_keys");
    const { authenticate } = await import("../src/auth/middleware");
    getDb();
    const { key } = createApiKey({
      name: "seed",
      permissions: { admin: true, scope: null },
      rawKey: "ck_seed_global_admin_12345",
    });
    const ctx = await authenticate(new Request("http://l", { headers: { "x-api-key": key } }));
    expect(ctx.isGlobalAdmin).toBe(true);
    expect(ctx.tenantId).toBeNull();
  });

  it("admin key scoped to a tenant is NOT a global admin", async () => {
    const { getDb } = await import("../src/db/client");
    const { createApiKey } = await import("../src/db/api_keys");
    const { authenticate } = await import("../src/auth/middleware");
    const { seedDefaultTenant, createTenant } = await import("../src/db/tenants");
    getDb();
    seedDefaultTenant();
    const t = createTenant({ name: "t" });
    const { key } = createApiKey({
      name: "tenant-admin",
      permissions: { admin: true, scope: null },
      tenantId: t.id,
      rawKey: "ck_tenant_admin_12345678901",
    });
    const ctx = await authenticate(new Request("http://l", { headers: { "x-api-key": key } }));
    expect(ctx.isGlobalAdmin).toBe(false);
    expect(ctx.tenantId).toBe(t.id);
  });

  it("non-admin key is never a global admin", async () => {
    const { getDb } = await import("../src/db/client");
    const { createApiKey } = await import("../src/db/api_keys");
    const { authenticate } = await import("../src/auth/middleware");
    getDb();
    const { key } = createApiKey({
      name: "user",
      permissions: { admin: false, scope: null },
      rawKey: "ck_non_admin_null_tenant_12",
    });
    const ctx = await authenticate(new Request("http://l", { headers: { "x-api-key": key } }));
    expect(ctx.isGlobalAdmin).toBe(false);
  });
});

describe("auth/scope.ts helpers", () => {
  it("tenantFilter: global admin → null; everyone else → their tenantId", async () => {
    const { tenantFilter } = await import("../src/auth/scope");
    const global: import("../src/types").AuthContext = {
      keyId: "k1", name: "g", permissions: { admin: true, scope: null },
      tenantId: null, isGlobalAdmin: true,
      budgetUsd: null, rateLimitRpm: null, spentUsd: 0,
    };
    const scoped: import("../src/types").AuthContext = {
      ...global, keyId: "k2", name: "s", tenantId: "tenant_abc", isGlobalAdmin: false,
    };
    expect(tenantFilter(global)).toBeNull();
    expect(tenantFilter(scoped)).toBe("tenant_abc");
  });

  it("requireGlobalAdmin: allows global admin; 403 on tenant admin", async () => {
    const { requireGlobalAdmin } = await import("../src/auth/scope");
    const global: import("../src/types").AuthContext = {
      keyId: "k1", name: "g", permissions: { admin: true, scope: null },
      tenantId: null, isGlobalAdmin: true,
      budgetUsd: null, rateLimitRpm: null, spentUsd: 0,
    };
    const tenantAdmin: import("../src/types").AuthContext = {
      ...global, keyId: "k2", name: "t", tenantId: "tenant_x", isGlobalAdmin: false,
    };
    expect(() => requireGlobalAdmin(global)).not.toThrow();
    expect(() => requireGlobalAdmin(tenantAdmin)).toThrow(/global admin/);
  });

  it("assertResourceTenant: global admin passes; tenant-match passes; mismatch throws 404", async () => {
    const { assertResourceTenant } = await import("../src/auth/scope");
    const global: import("../src/types").AuthContext = {
      keyId: "k1", name: "g", permissions: { admin: true, scope: null },
      tenantId: null, isGlobalAdmin: true,
      budgetUsd: null, rateLimitRpm: null, spentUsd: 0,
    };
    const scopedX: import("../src/types").AuthContext = {
      ...global, keyId: "k2", name: "x", tenantId: "tenant_x", isGlobalAdmin: false,
    };
    // Global admin: any resource tenant is fine
    expect(() => assertResourceTenant(global, "tenant_y", "nf")).not.toThrow();
    // Scoped caller: matching tenant passes
    expect(() => assertResourceTenant(scopedX, "tenant_x", "nf")).not.toThrow();
    // Scoped caller: mismatch throws 404 (not 403)
    expect(() => assertResourceTenant(scopedX, "tenant_y", "nf")).toThrow(/nf/);
  });

  it("resolveCreateTenant: global admin falls back to default tenant; tenant admin uses their own", async () => {
    const { resolveCreateTenant } = await import("../src/auth/scope");
    const global: import("../src/types").AuthContext = {
      keyId: "k1", name: "g", permissions: { admin: true, scope: null },
      tenantId: null, isGlobalAdmin: true,
      budgetUsd: null, rateLimitRpm: null, spentUsd: 0,
    };
    const scopedX: import("../src/types").AuthContext = {
      ...global, keyId: "k2", name: "x", tenantId: "tenant_x", isGlobalAdmin: false,
    };
    expect(resolveCreateTenant(global, "tenant_somewhere")).toBe("tenant_somewhere");
    // Global admin without an explicit tenant_id falls back to the
    // default tenant — preserves legacy one-tenant UX.
    expect(resolveCreateTenant(global, undefined)).toBe("tenant_default");
    // Tenant caller always gets their own tenant; body value is ignored
    expect(resolveCreateTenant(scopedX, "tenant_other")).toBe("tenant_x");
    expect(resolveCreateTenant(scopedX, undefined)).toBe("tenant_x");
  });
});
