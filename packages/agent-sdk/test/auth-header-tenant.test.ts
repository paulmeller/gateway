/**
 * Tests for the `x-agentstep-tenant` header — opt-in tenant impersonation
 * shipped in agent-sdk 0.5.44 (PR5 of the auth epic).
 *
 * The header lets a global-admin "service" key act on behalf of a
 * specific tenant without minting a per-tenant key. Validation:
 *
 *   - Shape: ^[a-zA-Z0-9_-]{1,64}$. Anything else → 400.
 *   - Mode: rejected in passthrough mode.
 *   - Authorization:
 *       - Global admin key → header value used as actingAsTenant.
 *       - Scoped key matching the header → accepted.
 *       - Scoped key mismatched → 403.
 *
 * Then `effectiveTenant(auth)` returns actingAsTenant when set, falling
 * back to the key's own tenantId. The three scope helpers route through
 * it; assertResourceTenant consults it BEFORE the global-admin bypass.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-auth-header-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown; __caInitialized?: unknown; __caInitPromise?: unknown;
    __caBusEmitters?: unknown; __caConfigCache?: unknown; __caRuntime?: unknown;
    __caSweeperHandle?: unknown; __caActors?: unknown; __caDrizzle?: unknown;
    __caLicense?: unknown;
  };
  delete g.__caDb; delete g.__caDrizzle; delete g.__caInitialized;
  delete g.__caInitPromise; delete g.__caBusEmitters; delete g.__caConfigCache;
  delete g.__caRuntime;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  delete g.__caActors; delete g.__caLicense;
}

function reqWith(apiKey: string, tenantHeader?: string): Request {
  const headers: Record<string, string> = { "x-api-key": apiKey };
  if (tenantHeader !== undefined) headers["x-agentstep-tenant"] = tenantHeader;
  return new Request("http://localhost/anthropic/v1/agents", { headers });
}

async function seedGlobalAdmin(): Promise<{ rawKey: string }> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({
    name: "service",
    permissions: { admin: true, scope: null },
    rawKey: "ck_test_global_admin_xxx",
    // tenantId omitted → null = global admin
  });
  return { rawKey: key };
}

async function seedScopedKey(tenantId: string): Promise<{ rawKey: string }> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createTenant } = await import("../src/db/tenants");
  try { createTenant({ id: tenantId, name: tenantId }); } catch { /* exists */ }
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({
    name: `scoped-${tenantId}`,
    permissions: { admin: true, scope: null },
    tenantId,
    rawKey: `ck_test_scoped_${tenantId}_xxx`,
  });
  return { rawKey: key };
}

describe("x-agentstep-tenant header — middleware", () => {
  beforeEach(() => freshDbEnv());

  it("1. global-admin key + valid header → actingAsTenant = header value", async () => {
    const { rawKey } = await seedGlobalAdmin();
    const { authenticate } = await import("../src/auth/middleware");
    const auth = await authenticate(reqWith(rawKey, "tenant_abc"));
    expect(auth.isGlobalAdmin).toBe(true);
    expect(auth.actingAsTenant).toBe("tenant_abc");
  });

  it("2. scoped key + matching header → ok, actingAsTenant = header", async () => {
    await seedGlobalAdmin();
    const { rawKey } = await seedScopedKey("tenant_acme");
    const { authenticate } = await import("../src/auth/middleware");
    const auth = await authenticate(reqWith(rawKey, "tenant_acme"));
    expect(auth.tenantId).toBe("tenant_acme");
    expect(auth.actingAsTenant).toBe("tenant_acme");
  });

  it("3. scoped key + mismatched header → 403", async () => {
    await seedGlobalAdmin();
    const { rawKey } = await seedScopedKey("tenant_acme");
    const { authenticate } = await import("../src/auth/middleware");
    await expect(authenticate(reqWith(rawKey, "tenant_other"))).rejects.toMatchObject({
      status: 403,
    });
  });

  it("4. malformed header → 400", async () => {
    const { rawKey } = await seedGlobalAdmin();
    const { authenticate } = await import("../src/auth/middleware");
    await expect(authenticate(reqWith(rawKey, "bad name with spaces!"))).rejects.toMatchObject({
      status: 400,
    });
  });

  it("5. no header → existing behavior unchanged, actingAsTenant = null", async () => {
    const { rawKey } = await seedGlobalAdmin();
    const { authenticate } = await import("../src/auth/middleware");
    const auth = await authenticate(reqWith(rawKey));
    expect(auth.actingAsTenant).toBeNull();
    expect(auth.tenantId).toBeNull();
    expect(auth.isGlobalAdmin).toBe(true);
  });

  it("10. passthrough mode + header → 400", async () => {
    // Flip env BEFORE the seed so the config cache is fresh, then
    // invalidate so authenticate() sees the override.
    process.env.ANTHROPIC_PASSTHROUGH_ENABLED = "1";
    await seedGlobalAdmin();
    const { invalidateConfigCache } = await import("../src/config");
    invalidateConfigCache();
    try {
      const { authenticate } = await import("../src/auth/middleware");
      // sk-ant-api* shape; valid enough to be classified as Anthropic
      const sk = "sk-ant-api03-" + "x".repeat(40);
      const req = new Request("http://localhost/anthropic/v1/agents", {
        headers: { "x-api-key": sk, "x-agentstep-tenant": "tenant_abc" },
      });
      await expect(authenticate(req)).rejects.toMatchObject({ status: 400 });
    } finally {
      delete process.env.ANTHROPIC_PASSTHROUGH_ENABLED;
      invalidateConfigCache();
    }
  });
});

describe("x-agentstep-tenant header — scope helpers", () => {
  beforeEach(() => freshDbEnv());

  it("6. resolveCreateTenant with header → returns header value", async () => {
    const { rawKey } = await seedGlobalAdmin();
    const { authenticate } = await import("../src/auth/middleware");
    const auth = await authenticate(reqWith(rawKey, "tenant_xyz"));
    const { resolveCreateTenant } = await import("../src/auth/scope");
    // Body tenant_id provided would normally win for global admin, but
    // the header takes precedence (per the design).
    expect(resolveCreateTenant(auth, "tenant_body_value")).toBe("tenant_xyz");
    expect(resolveCreateTenant(auth, undefined)).toBe("tenant_xyz");
  });

  it("7. tenantFilter with header → returns header value (not null)", async () => {
    const { rawKey } = await seedGlobalAdmin();
    const { authenticate } = await import("../src/auth/middleware");
    const { tenantFilter } = await import("../src/auth/scope");

    // Without header: global admin sees everything (null filter).
    const authNoHeader = await authenticate(reqWith(rawKey));
    expect(tenantFilter(authNoHeader)).toBeNull();

    // With header: scoped down to that tenant.
    const authWithHeader = await authenticate(reqWith(rawKey, "tenant_abc"));
    expect(tenantFilter(authWithHeader)).toBe("tenant_abc");
  });

  it("8. assertResourceTenant rejects when resource tenant ≠ effective tenant (scoped caller)", async () => {
    await seedGlobalAdmin();
    const { rawKey } = await seedScopedKey("tenant_acme");
    const { authenticate } = await import("../src/auth/middleware");
    const auth = await authenticate(reqWith(rawKey));
    const { assertResourceTenant } = await import("../src/auth/scope");
    expect(() => assertResourceTenant(auth, "tenant_acme", "nf")).not.toThrow();
    expect(() => assertResourceTenant(auth, "tenant_other", "nf")).toThrow(/nf/);
  });

  it("9. global-admin key + header + accessing resource from DIFFERENT tenant → 404 (assert-before-bypass)", async () => {
    // This is the critical case: without the precedence fix,
    // a global-admin key acting as tenant_a could still see
    // tenant_b's resources because the isGlobalAdmin bypass would
    // short-circuit before the effectiveTenant check.
    const { rawKey } = await seedGlobalAdmin();
    const { authenticate } = await import("../src/auth/middleware");
    const auth = await authenticate(reqWith(rawKey, "tenant_a"));
    expect(auth.isGlobalAdmin).toBe(true);
    expect(auth.actingAsTenant).toBe("tenant_a");

    const { assertResourceTenant } = await import("../src/auth/scope");
    // Matching tenant: ok
    expect(() => assertResourceTenant(auth, "tenant_a", "nf")).not.toThrow();
    // Different tenant: must throw, even though caller is global admin.
    expect(() => assertResourceTenant(auth, "tenant_b", "nf")).toThrow(/nf/);
    // Resource with null tenant (legacy): also rejected.
    expect(() => assertResourceTenant(auth, null, "nf")).toThrow(/nf/);
  });
});
