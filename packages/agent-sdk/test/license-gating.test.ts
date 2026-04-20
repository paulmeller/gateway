/**
 * License gating tests — community vs enterprise feature control.
 *
 * Covers:
 *   - requireFeature() throws 403 on community tier
 *   - requireFeature() passes on enterprise tier
 *   - DISABLE_EXPERIMENTAL_FEATURES kill switch
 *   - 20-key cap enforcement
 *   - Audit retention 7-day cap on community
 *   - getLicenseInfo() shape
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-license-test-"));
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
  delete g.__caLicense;
  delete g.__caRateLimitBuckets;
}

describe("license module", () => {
  beforeEach(() => freshDbEnv());

  it("community tier: requireFeature throws 403", async () => {
    const saved = process.env.AGENTSTEP_LICENSE_KEY;
    delete process.env.AGENTSTEP_LICENSE_KEY;
    try {
      const { _setLicenseForTesting, requireFeature } = await import("../src/license");
      _setLicenseForTesting("community");

      expect(() => requireFeature("tenancy")).toThrow(/requires.*Enterprise/i);
      expect(() => requireFeature("budgets")).toThrow(/requires.*Enterprise/i);
      expect(() => requireFeature("upstream_pool")).toThrow(/requires.*Enterprise/i);
    } finally {
      if (saved) process.env.AGENTSTEP_LICENSE_KEY = saved;
    }
  });

  it("enterprise tier: requireFeature passes", async () => {
    const { _setLicenseForTesting, requireFeature } = await import("../src/license");
    _setLicenseForTesting("enterprise");
    expect(() => requireFeature("tenancy")).not.toThrow();
    expect(() => requireFeature("budgets")).not.toThrow();
  });

  it("DISABLE_EXPERIMENTAL_FEATURES=1 blocks even enterprise", async () => {
    process.env.DISABLE_EXPERIMENTAL_FEATURES = "1";
    try {
      const { _setLicenseForTesting, requireFeature } = await import("../src/license");
      _setLicenseForTesting("enterprise");
      expect(() => requireFeature("tenancy")).toThrow(/temporarily disabled/i);
    } finally {
      delete process.env.DISABLE_EXPERIMENTAL_FEATURES;
    }
  });

  it("getLicenseInfo returns correct shape for community", async () => {
    const saved = process.env.AGENTSTEP_LICENSE_KEY;
    delete process.env.AGENTSTEP_LICENSE_KEY;
    try {
      const { _setLicenseForTesting, getLicenseInfo } = await import("../src/license");
      _setLicenseForTesting("community");
      const info = getLicenseInfo();
      expect(info.plan).toBe("community");
      expect(info.features).toEqual([]);
      expect(info.limits).toBeTruthy();
      expect(info.limits!.maxKeys).toBe(20);
      expect(info.limits!.auditRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
    } finally {
      if (saved) process.env.AGENTSTEP_LICENSE_KEY = saved;
    }
  });

  it("getLicenseInfo returns correct shape for enterprise", async () => {
    const { _setLicenseForTesting, getLicenseInfo } = await import("../src/license");
    _setLicenseForTesting("enterprise");
    const info = getLicenseInfo();
    expect(info.plan).toBe("enterprise");
    expect(info.features.length).toBeGreaterThan(0);
    expect(info.limits).toBeNull();
  });
});

describe("license: 20-key cap on community", () => {
  beforeEach(() => freshDbEnv());

  it("community tier rejects key creation beyond cap", async () => {
    const saved = process.env.AGENTSTEP_LICENSE_KEY;
    delete process.env.AGENTSTEP_LICENSE_KEY;
    try {
      const { getDb } = await import("../src/db/client");
      getDb();
      const { _setLicenseForTesting, COMMUNITY_LIMITS } = await import("../src/license");
      _setLicenseForTesting("community");
      const { createApiKey } = await import("../src/db/api_keys");
      const { handleCreateApiKey } = await import("../src/handlers/api_keys");

      // Seed keys up to the cap
      for (let i = 0; i < COMMUNITY_LIMITS.maxKeys; i++) {
        createApiKey({ name: `key-${i}`, permissions: { admin: false, scope: null } });
      }

      // The admin key for making the API call
      const { key: adminKey } = createApiKey({
        name: "admin",
        permissions: { admin: true, scope: null },
        rawKey: "ck_test_admin_license_cap",
      });

      const res = await handleCreateApiKey(
        new Request("http://localhost/v1/api-keys", {
          method: "POST",
          headers: { "x-api-key": adminKey, "content-type": "application/json" },
          body: JSON.stringify({ name: "over-cap" }),
        }),
      );
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { message: string } };
      expect(body.error.message).toMatch(/more than 20/i);
    } finally {
      if (saved) process.env.AGENTSTEP_LICENSE_KEY = saved;
    }
  });
});

describe("license: audit retention cap", () => {
  beforeEach(() => freshDbEnv());

  it("community tier limits audit reads to 7 days", async () => {
    const saved = process.env.AGENTSTEP_LICENSE_KEY;
    delete process.env.AGENTSTEP_LICENSE_KEY;
    try {
      const { getDb } = await import("../src/db/client");
      getDb();
      const { _setLicenseForTesting } = await import("../src/license");
      _setLicenseForTesting("community");
      const { recordAudit, listAudit } = await import("../src/db/audit");
      const { nowMs } = await import("../src/util/clock");

      // Write an old entry (8 days ago) and a recent one
      const eightDaysAgo = nowMs() - 8 * 24 * 60 * 60 * 1000;
      const db = getDb();
      db.prepare(
        `INSERT INTO audit_log (id, created_at, action, outcome) VALUES (?, ?, ?, ?)`,
      ).run("audit_old", eightDaysAgo, "test.old", "success");

      recordAudit({ auth: null, action: "test.recent" });

      const rows = listAudit({});
      // Should only see the recent one, not the 8-day-old one
      expect(rows.length).toBe(1);
      expect(rows[0].action).toBe("test.recent");
    } finally {
      if (saved) process.env.AGENTSTEP_LICENSE_KEY = saved;
    }
  });
});
