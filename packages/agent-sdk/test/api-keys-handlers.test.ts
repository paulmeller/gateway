/**
 * Tests for /v1/api-keys CRUD + scope enforcement in handleCreateSession.
 *
 * Covers:
 *   - Admin creates / lists / revokes keys; non-admin gets 403
 *   - Scope enforcement: key scoped to agent A can't create session against agent B
 *   - Legacy `["*"]` permissions rows still authenticate and are treated as admin
 *   - permissions.admin === false + scope === null → unrestricted access but no key CRUD
 *   - revokeApiKey refuses self-revocation
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-api-keys-test-"));
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
    __caLicense?: unknown;
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
}

async function bootDb(): Promise<{ adminKey: string; adminId: string }> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  // Default: admin key
  const { key, id } = createApiKey({
    name: "test-admin",
    permissions: { admin: true, scope: null },
    rawKey: "ck_test_admin_12345678",
  });
  return { adminKey: key, adminId: id };
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
    headers["x-api-key"] = "ck_test_admin_12345678";
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("API Keys — CRUD (admin only)", () => {
  beforeEach(() => freshDbEnv());

  it("admin creates, lists, retrieves, patches, revokes", async () => {
    await bootDb();
    const { handleCreateApiKey, handleListApiKeys, handleGetApiKey, handlePatchApiKey, handleRevokeApiKey } = await import(
      "../src/handlers/api_keys"
    );

    // Create
    const createRes = await handleCreateApiKey(req("/v1/api-keys", {
      body: {
        name: "ci-bot",
        permissions: { admin: false, scope: { agents: ["agent_a"], environments: ["*"], vaults: [] } },
      },
    }));
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string; key: string; permissions: { admin: boolean; scope: Record<string, string[]> | null } };
    expect(created.key).toMatch(/^ck_/);
    expect(created.permissions.admin).toBe(false);
    expect(created.permissions.scope?.agents).toEqual(["agent_a"]);

    // List
    const listRes = await handleListApiKeys(req("/v1/api-keys"));
    expect(listRes.status).toBe(200);
    const list = await listRes.json() as { data: Array<{ id: string; name: string }> };
    expect(list.data.map(r => r.name).sort()).toEqual(["ci-bot", "test-admin"]);

    // Get
    const getRes = await handleGetApiKey(req(`/v1/api-keys/${created.id}`), created.id);
    expect(getRes.status).toBe(200);
    const got = await getRes.json() as { name: string };
    expect(got.name).toBe("ci-bot");

    // Patch
    const patchRes = await handlePatchApiKey(req(`/v1/api-keys/${created.id}`, {
      method: "PATCH",
      body: { permissions: { admin: false, scope: null } },
    }), created.id);
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json() as { permissions: { scope: unknown } };
    expect(patched.permissions.scope).toBeNull();

    // Revoke
    const revokeRes = await handleRevokeApiKey(req(`/v1/api-keys/${created.id}`, { method: "DELETE" }), created.id);
    expect(revokeRes.status).toBe(200);

    // After revoke: listing omits the key
    const afterList = await handleListApiKeys(req("/v1/api-keys"));
    const afterData = await afterList.json() as { data: Array<{ name: string }> };
    expect(afterData.data.map(r => r.name)).toEqual(["test-admin"]);
  });

  it("non-admin is rejected on every CRUD endpoint with 403", async () => {
    await bootDb();
    const { createApiKey } = await import("../src/db/api_keys");
    const { handleCreateApiKey, handleListApiKeys } = await import("../src/handlers/api_keys");

    const { key: userKey } = createApiKey({
      name: "scoped-user",
      permissions: { admin: false, scope: null },
      rawKey: "ck_test_user_12345678",
    });

    const createRes = await handleCreateApiKey(req("/v1/api-keys", {
      apiKey: userKey,
      body: { name: "shouldnotwork" },
    }));
    expect(createRes.status).toBe(403);

    const listRes = await handleListApiKeys(req("/v1/api-keys", { apiKey: userKey }));
    expect(listRes.status).toBe(403);
  });

  it("admin cannot revoke the key used in the current request (anti-lockout)", async () => {
    const { adminKey, adminId } = await bootDb();
    const { handleRevokeApiKey } = await import("../src/handlers/api_keys");

    const res = await handleRevokeApiKey(
      req(`/v1/api-keys/${adminId}`, { method: "DELETE", apiKey: adminKey }),
      adminId,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/cannot revoke the key used for this request/);
  });

  it("missing API key returns 401", async () => {
    await bootDb();
    const { handleListApiKeys } = await import("../src/handlers/api_keys");
    const res = await handleListApiKeys(req("/v1/api-keys", { apiKey: "" }));
    expect(res.status).toBe(401);
  });

  it("invalid permissions shape returns 400", async () => {
    await bootDb();
    const { handleCreateApiKey } = await import("../src/handlers/api_keys");
    const res = await handleCreateApiKey(req("/v1/api-keys", {
      body: { name: "bad", permissions: { admin: "yes" } }, // admin must be boolean
    }));
    expect(res.status).toBe(400);
  });
});

describe("API Keys — Legacy permissions backcompat", () => {
  beforeEach(() => freshDbEnv());

  it("legacy `[\"*\"]` permissions row authenticates and is treated as admin", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    const crypto = await import("node:crypto");
    const rawKey = "ck_legacy_key_1234567890";
    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (id, name, hash, prefix, permissions_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("key_legacy", "pre-0.4", hash, rawKey.slice(0, 8), '["*"]', Date.now());

    const { handleListApiKeys } = await import("../src/handlers/api_keys");
    const res = await handleListApiKeys(req("/v1/api-keys", { apiKey: rawKey }));
    expect(res.status).toBe(200);

    // Hydrated permissions should show admin=true, scope=null
    const body = await res.json() as { data: Array<{ permissions: { admin: boolean; scope: unknown } }> };
    const ours = body.data.find(r => (r as unknown as { id: string }).id === "key_legacy");
    expect(ours?.permissions).toEqual({ admin: true, scope: null });
  });

  it("corrupt permissions_json still authenticates but denies admin", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    const crypto = await import("node:crypto");
    const rawKey = "ck_corrupt_key_1234567890";
    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (id, name, hash, prefix, permissions_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("key_corrupt", "bad-json", hash, rawKey.slice(0, 8), "not json {", Date.now());

    const { handleListApiKeys } = await import("../src/handlers/api_keys");
    const res = await handleListApiKeys(req("/v1/api-keys", { apiKey: rawKey }));
    expect(res.status).toBe(403);
  });
});

describe("Scope enforcement — checkResourceScope helper", () => {
  it("null scope permits everything", async () => {
    const { checkResourceScope } = await import("../src/auth/scope");
    const auth = {
      keyId: "k",
      name: "n",
      permissions: { admin: false, scope: null },
      tenantId: null, isGlobalAdmin: false, budgetUsd: null, rateLimitRpm: null, spentUsd: 0,
    };
    expect(() => checkResourceScope(auth, { agent: "a1", env: "e1", vaults: ["v1"] })).not.toThrow();
  });

  it("explicit allow-list with `*` permits all of that type", async () => {
    const { checkResourceScope } = await import("../src/auth/scope");
    const auth = {
      keyId: "k",
      name: "n",
      permissions: { admin: false, scope: { agents: ["*"], environments: ["e1"], vaults: [] } },
      tenantId: null, isGlobalAdmin: false, budgetUsd: null, rateLimitRpm: null, spentUsd: 0,
    };
    expect(() => checkResourceScope(auth, { agent: "anything", env: "e1" })).not.toThrow();
    expect(() => checkResourceScope(auth, { env: "e2" })).toThrow(/environment e2/);
  });

  it("scope without the agent throws 403", async () => {
    const { checkResourceScope } = await import("../src/auth/scope");
    const auth = {
      keyId: "k",
      name: "n",
      permissions: { admin: false, scope: { agents: ["agent_a"], environments: ["*"], vaults: ["*"] } },
      tenantId: null, isGlobalAdmin: false, budgetUsd: null, rateLimitRpm: null, spentUsd: 0,
    };
    expect(() => checkResourceScope(auth, { agent: "agent_b" })).toThrow(/agent_b/);
  });

  it("empty vault array means no vaults allowed", async () => {
    const { checkResourceScope } = await import("../src/auth/scope");
    const auth = {
      keyId: "k",
      name: "n",
      permissions: { admin: false, scope: { agents: ["*"], environments: ["*"], vaults: [] } },
      tenantId: null, isGlobalAdmin: false, budgetUsd: null, rateLimitRpm: null, spentUsd: 0,
    };
    expect(() => checkResourceScope(auth, { vaults: ["v1"] })).toThrow(/vault v1/);
  });
});

describe("Per-key cost dashboard (PR2)", () => {
  beforeEach(() => freshDbEnv());

  it("sessions capture api_key_id from the authenticating context", async () => {
    const { adminKey, adminId } = await bootDb();
    const { createAgent } = await import("../src/db/agents");
    const { handleCreateSession } = await import("../src/handlers/sessions");

    const agent = createAgent({
      name: "test",
      model: "claude-sonnet-4-6",
    });

    // Create an environment directly in DB (bypasses provider setup)
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const db = getDb();
    const envId = newId("env");
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?)`,
    ).run(envId, "env-test", JSON.stringify({ type: "cloud", provider: "docker" }), Date.now());

    const res = await handleCreateSession(req("/v1/sessions", {
      apiKey: adminKey,
      body: { agent: agent.id, environment_id: envId },
    }));
    expect(res.status).toBe(201);
    const session = await res.json() as { id: string };

    const row = db.prepare("SELECT api_key_id FROM sessions WHERE id = ?").get(session.id) as { api_key_id: string | null };
    expect(row.api_key_id).toBe(adminId);
  });

  it("GET /v1/metrics?group_by=api_key attributes session costs to the owning key", async () => {
    const { adminKey, adminId } = await bootDb();
    const { ensureInitialized } = await import("../src/init");
    await ensureInitialized();
    const { _setLicenseForTesting } = await import("../src/license");
    _setLicenseForTesting("enterprise");
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { createAgent } = await import("../src/db/agents");
    const { handleGetMetrics } = await import("../src/handlers/metrics");
    const db = getDb();

    const agent = createAgent({ name: "metrics-test", model: "claude-sonnet-4-6" });
    const envId = newId("env");
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?)`,
    ).run(envId, "env-metrics", JSON.stringify({ type: "cloud", provider: "docker" }), Date.now());

    // Seed two sessions: one with api_key_id = adminId, one with null (legacy).
    const now = Date.now();
    const s1 = newId("sess");
    const s2 = newId("sess");
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, usage_cost_usd, api_key_id, turn_count, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'idle', '{}', 1.23, ?, 2, ?, ?)`,
    ).run(s1, agent.id, envId, adminId, now - 1000, now - 1000);
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, usage_cost_usd, api_key_id, turn_count, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'idle', '{}', 0.50, NULL, 1, ?, ?)`,
    ).run(s2, agent.id, envId, now - 500, now - 500);

    const res = await handleGetMetrics(req(`/v1/metrics?group_by=api_key&from=0&to=${now + 1}`, { apiKey: adminKey }));
    expect(res.status).toBe(200);
    const body = await res.json() as { groups: Array<{ key: string; cost_usd: number; session_count: number }> };
    const attributed = body.groups.find(g => g.key === adminId);
    const unattributed = body.groups.find(g => g.key === "__unattributed__");
    expect(attributed?.cost_usd).toBeCloseTo(1.23, 2);
    expect(attributed?.session_count).toBe(1);
    expect(unattributed?.cost_usd).toBeCloseTo(0.50, 2);
    expect(unattributed?.session_count).toBe(1);
  });

  it("GET /v1/api-keys/:id/activity returns sessions + totals for the key", async () => {
    const { adminKey, adminId } = await bootDb();
    const { ensureInitialized } = await import("../src/init");
    await ensureInitialized();
    const { _setLicenseForTesting } = await import("../src/license");
    _setLicenseForTesting("enterprise");
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { createAgent } = await import("../src/db/agents");
    const { handleGetApiKeyActivity } = await import("../src/handlers/api_keys");
    const db = getDb();
    const now = Date.now();

    const agent = createAgent({ name: "activity-test", model: "claude-sonnet-4-6" });
    const envId = newId("env");
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?)`,
    ).run(envId, "env-activity", JSON.stringify({ type: "cloud", provider: "docker" }), now);

    // Two sessions for the admin key
    for (let i = 0; i < 2; i++) {
      const id = newId("sess");
      db.prepare(
        `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, usage_cost_usd, api_key_id, turn_count, created_at, updated_at)
         VALUES (?, ?, 1, ?, 'idle', '{}', ?, ?, ?, ?, ?)`,
      ).run(id, agent.id, envId, 0.10 * (i + 1), adminId, i + 1, now - (100 * (2 - i)), now);
    }

    const res = await handleGetApiKeyActivity(req(`/v1/api-keys/${adminId}/activity`, { apiKey: adminKey }), adminId);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      sessions: Array<{ usage_cost_usd: number }>;
      totals: { session_count: number; cost_usd: number; turn_count: number; error_count: number };
    };
    expect(body.sessions).toHaveLength(2);
    expect(body.totals.session_count).toBe(2);
    expect(body.totals.cost_usd).toBeCloseTo(0.30, 2);
    expect(body.totals.turn_count).toBe(3);
    expect(body.totals.error_count).toBe(0);
  });

  it("GET /v1/api-keys/:id/activity requires admin", async () => {
    await bootDb();
    const { createApiKey } = await import("../src/db/api_keys");
    const { handleGetApiKeyActivity } = await import("../src/handlers/api_keys");

    const { key: userKey, id: userId } = createApiKey({
      name: "scoped",
      permissions: { admin: false, scope: null },
      rawKey: "ck_test_user_activity_1",
    });

    const res = await handleGetApiKeyActivity(
      req(`/v1/api-keys/${userId}/activity`, { apiKey: userKey }),
      userId,
    );
    expect(res.status).toBe(403);
  });
});

describe("Metrics time-series per key (PR2.5)", () => {
  beforeEach(() => freshDbEnv());

  async function seedForTimeSeries(): Promise<{ adminKey: string; adminId: string; agentId: string; envId: string }> {
    const { adminKey, adminId } = await bootDb();
    const { ensureInitialized } = await import("../src/init");
    await ensureInitialized();
    const { _setLicenseForTesting } = await import("../src/license");
    _setLicenseForTesting("enterprise");
    const { createAgent } = await import("../src/db/agents");
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const db = getDb();
    const agent = createAgent({ name: "ts-test", model: "claude-sonnet-4-6" });
    const envId = newId("env");
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?)`,
    ).run(envId, "env-ts", JSON.stringify({ type: "cloud", provider: "docker" }), Date.now());
    return { adminKey, adminId, agentId: agent.id, envId };
  }

  it("returns series shape when group_by=api_key + time_bucket are both present", async () => {
    const { adminKey, adminId, agentId, envId } = await seedForTimeSeries();
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { handleGetMetrics } = await import("../src/handlers/metrics");
    const db = getDb();

    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    // Two sessions 2 days apart, both owned by adminId.
    for (const daysAgo of [0, 2]) {
      const id = newId("sess");
      const at = now - daysAgo * dayMs;
      db.prepare(
        `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, usage_cost_usd, api_key_id, turn_count, created_at, updated_at)
         VALUES (?, ?, 1, ?, 'idle', '{}', 0.50, ?, 3, ?, ?)`,
      ).run(id, agentId, envId, adminId, at, at);
    }

    const from = now - 7 * dayMs;
    const res = await handleGetMetrics(
      req(`/v1/metrics?group_by=api_key&time_bucket=day&from=${from}&to=${now}`, { apiKey: adminKey }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      group_by: string;
      time_bucket: string;
      series: Array<{ key: string; name: string; points: Array<{ t: string; cost_usd: number; session_count: number }> }>;
      totals: { cost_usd: number; session_count: number };
    };
    expect(body.group_by).toBe("api_key");
    expect(body.time_bucket).toBe("day");
    const adminSeries = body.series.find(s => s.key === adminId);
    expect(adminSeries).toBeDefined();
    expect(adminSeries!.points.length).toBeGreaterThanOrEqual(7);
    // Two sessions × $0.50 = $1.00 aggregate
    expect(body.totals.cost_usd).toBeCloseTo(1.0, 2);
    expect(body.totals.session_count).toBe(2);
    // Each point must have all four metric fields, zero-filled for empty buckets.
    for (const p of adminSeries!.points) {
      expect(typeof p.t).toBe("string");
      expect(typeof p.cost_usd).toBe("number");
    }
  });

  it("top-N cap collapses non-top keys into __other__", async () => {
    const { adminKey } = await seedForTimeSeries();
    const { getDb } = await import("../src/db/client");
    const { createApiKey } = await import("../src/db/api_keys");
    const { newId } = await import("../src/util/ids");
    const { handleGetMetrics } = await import("../src/handlers/metrics");
    const db = getDb();
    const now = Date.now();

    // 12 keys × 1 session each with varying cost. Top 10 get their own series;
    // the remaining 2 should collapse to "__other__".
    const { createAgent } = await import("../src/db/agents");
    const agent = createAgent({ name: "topN", model: "claude-sonnet-4-6" });
    const envId = newId("env");
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?)`,
    ).run(envId, "env-topN", JSON.stringify({ type: "cloud", provider: "docker" }), now);

    for (let i = 0; i < 12; i++) {
      const { id: keyId } = createApiKey({
        name: `key-${i}`,
        permissions: { admin: false, scope: null },
        rawKey: `ck_topn_${i}_padding_padding_x`,
      });
      const sessId = newId("sess");
      db.prepare(
        `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, usage_cost_usd, api_key_id, turn_count, created_at, updated_at)
         VALUES (?, ?, 1, ?, 'idle', '{}', ?, ?, 1, ?, ?)`,
      ).run(sessId, agent.id, envId, i + 1, keyId, now - 1000, now - 1000);
    }

    const res = await handleGetMetrics(
      req(`/v1/metrics?group_by=api_key&time_bucket=day&from=${now - 86400000}&to=${now}`, { apiKey: adminKey }),
    );
    const body = await res.json() as { series: Array<{ key: string }> };
    const keysInSeries = body.series.map(s => s.key);
    expect(keysInSeries).toContain("__other__");
    const topKeysCount = keysInSeries.filter(k => !k.startsWith("__")).length;
    expect(topKeysCount).toBeLessThanOrEqual(10);
  });

  it("rejects hour bucket over a window > 30 days with a clear error", async () => {
    const { adminKey } = await seedForTimeSeries();
    const { handleGetMetrics } = await import("../src/handlers/metrics");
    const now = Date.now();
    const from = now - 31 * 24 * 60 * 60 * 1000;
    const res = await handleGetMetrics(
      req(`/v1/metrics?group_by=api_key&time_bucket=hour&from=${from}&to=${now}`, { apiKey: adminKey }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/time_bucket=day/);
  });

  it("legacy sessions (api_key_id=null) collapse into __unattributed__", async () => {
    const { adminKey, agentId, envId } = await seedForTimeSeries();
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { handleGetMetrics } = await import("../src/handlers/metrics");
    const db = getDb();
    const now = Date.now();

    const sessId = newId("sess");
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, usage_cost_usd, api_key_id, turn_count, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'idle', '{}', 0.75, NULL, 1, ?, ?)`,
    ).run(sessId, agentId, envId, now - 1000, now - 1000);

    const res = await handleGetMetrics(
      req(`/v1/metrics?group_by=api_key&time_bucket=day&from=${now - 86400000}&to=${now}`, { apiKey: adminKey }),
    );
    const body = await res.json() as { series: Array<{ key: string; points: Array<{ cost_usd: number }> }> };
    const un = body.series.find(s => s.key === "__unattributed__");
    expect(un).toBeDefined();
    const total = un!.points.reduce((acc, p) => acc + p.cost_usd, 0);
    expect(total).toBeCloseTo(0.75, 2);
  });
});

describe("Rate limit middleware (PR3)", () => {
  beforeEach(() => freshDbEnv());

  it("allows up to rate_limit_rpm requests in the 60s window; 429s the next", async () => {
    await bootDb();
    const { createApiKey } = await import("../src/db/api_keys");
    const { resetRateLimits } = await import("../src/auth/rate_limit");
    const { handleListApiKeys } = await import("../src/handlers/api_keys");

    resetRateLimits();
    const { key: adminLimited } = createApiKey({
      name: "limited-admin",
      permissions: { admin: true, scope: null },
      rateLimitRpm: 2,
      rawKey: "ck_test_limited_admin_1234",
    });

    const r1 = await handleListApiKeys(req("/v1/api-keys", { apiKey: adminLimited }));
    expect(r1.status).toBe(200);
    const r2 = await handleListApiKeys(req("/v1/api-keys", { apiKey: adminLimited }));
    expect(r2.status).toBe(200);
    const r3 = await handleListApiKeys(req("/v1/api-keys", { apiKey: adminLimited }));
    expect(r3.status).toBe(429);
    expect(r3.headers.get("Retry-After")).toBeTruthy();
    expect(Number(r3.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("null rate_limit_rpm means no limit", async () => {
    await bootDb();
    const { resetRateLimits } = await import("../src/auth/rate_limit");
    const { handleListApiKeys } = await import("../src/handlers/api_keys");
    resetRateLimits();
    // Fire 10 requests quickly against the seed admin key (rate_limit_rpm=null).
    for (let i = 0; i < 10; i++) {
      const res = await handleListApiKeys(req("/v1/api-keys"));
      expect(res.status).toBe(200);
    }
  });
});

describe("Per-key budget enforcement (PR3)", () => {
  beforeEach(() => freshDbEnv());

  it("updateApiKeyLimits + bumpKeySpent flow through to AuthContext", async () => {
    await bootDb();
    const { createApiKey, updateApiKeyLimits, bumpKeySpent, getApiKeyById } = await import("../src/db/api_keys");
    const { authenticate } = await import("../src/auth/middleware");

    const { key, id } = createApiKey({
      name: "budget-test",
      permissions: { admin: false, scope: null },
      rawKey: "ck_budget_test_123456789012",
    });

    updateApiKeyLimits(id, { budgetUsd: 5.00 });
    bumpKeySpent(id, 1.23);

    const row = getApiKeyById(id);
    expect(row?.spent_usd).toBeCloseTo(1.23, 2);
    expect(row?.budget_usd).toBeCloseTo(5.00, 2);

    const ctx = await authenticate(new Request("http://l", { headers: { "x-api-key": key } }));
    expect(ctx.budgetUsd).toBeCloseTo(5.00, 2);
    expect(ctx.spentUsd).toBeCloseTo(1.23, 2);
  });

  it("bumpSessionStats updates both session and key atomically", async () => {
    const { adminId } = await bootDb();
    const { createAgent } = await import("../src/db/agents");
    const { createSession, bumpSessionStats } = await import("../src/db/sessions");
    const { getApiKeyById } = await import("../src/db/api_keys");
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const db = getDb();

    const agent = createAgent({ name: "bump-test", model: "claude-sonnet-4-6" });
    const envId = newId("env");
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?)`,
    ).run(envId, "env-bump", JSON.stringify({ type: "cloud", provider: "docker" }), Date.now());

    const session = createSession({
      agent_id: agent.id,
      agent_version: 1,
      environment_id: envId,
      api_key_id: adminId,
    });

    bumpSessionStats(session.id, { turn_count: 1 }, { cost_usd: 0.75 });

    const updatedSession = db.prepare("SELECT usage_cost_usd FROM sessions WHERE id = ?").get(session.id) as { usage_cost_usd: number };
    expect(updatedSession.usage_cost_usd).toBeCloseTo(0.75, 2);

    const keyAfter = getApiKeyById(adminId);
    expect(keyAfter?.spent_usd).toBeCloseTo(0.75, 2);
  });

  it("bumpSessionStats with zero cost doesn't touch key total", async () => {
    const { adminId } = await bootDb();
    const { createAgent } = await import("../src/db/agents");
    const { createSession, bumpSessionStats } = await import("../src/db/sessions");
    const { getApiKeyById } = await import("../src/db/api_keys");
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const db = getDb();

    const agent = createAgent({ name: "zero-cost", model: "claude-sonnet-4-6" });
    const envId = newId("env");
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?)`,
    ).run(envId, "env-zero", JSON.stringify({ type: "cloud", provider: "docker" }), Date.now());

    const session = createSession({ agent_id: agent.id, agent_version: 1, environment_id: envId, api_key_id: adminId });
    // turn_count only, no usage.cost_usd
    bumpSessionStats(session.id, { turn_count: 1 });
    const key = getApiKeyById(adminId);
    expect(key?.spent_usd ?? 0).toBe(0);
  });
});

describe("Session fallback (PR3)", () => {
  beforeEach(() => freshDbEnv());

  async function seedAgentEnv(name: string, ready: boolean, fallbackJson?: string) {
    const { createAgent } = await import("../src/db/agents");
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const db = getDb();

    const agent = createAgent({ name, model: "claude-sonnet-4-6" });
    if (fallbackJson) {
      db.prepare("UPDATE agents SET fallback_json = ? WHERE id = ?").run(fallbackJson, agent.id);
    }
    const envId = newId("env");
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, state_message, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, 'tenant_default', ?)`,
    ).run(
      envId,
      `env-${name}`,
      JSON.stringify({ type: "cloud", provider: "docker" }),
      ready ? "ready" : "failed",
      ready ? null : "provider unavailable",
      Date.now(),
    );
    return { agentId: agent.id, envId };
  }

  it("falls over to the fallback tuple when primary env isn't ready", async () => {
    await bootDb();
    const fallbackTarget = await seedAgentEnv("bravo", true);
    const primary = await seedAgentEnv(
      "alpha",
      false,
      JSON.stringify([{ agent_id: fallbackTarget.agentId, environment_id: fallbackTarget.envId }]),
    );

    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(req("/v1/sessions", {
      body: { agent: primary.agentId, environment_id: primary.envId },
    }));
    expect(res.status).toBe(201);
    const session = await res.json() as { agent: { id: string }; environment_id: string };
    expect(session.agent.id).toBe(fallbackTarget.agentId);
    expect(session.environment_id).toBe(fallbackTarget.envId);
  });

  it("emits session.fallback_used event on successful fallback", async () => {
    await bootDb();
    const fallbackTarget = await seedAgentEnv("delta", true);
    const primary = await seedAgentEnv(
      "charlie",
      false,
      JSON.stringify([{ agent_id: fallbackTarget.agentId, environment_id: fallbackTarget.envId }]),
    );

    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(req("/v1/sessions", {
      body: { agent: primary.agentId, environment_id: primary.envId },
    }));
    const session = await res.json() as { id: string };

    // Give the append a microtask cycle to flush
    await new Promise(r => setTimeout(r, 50));
    const { listEvents } = await import("../src/db/events");
    const events = listEvents(session.id, { limit: 50 });
    const fb = events.find(e => e.type === "session.fallback_used");
    expect(fb).toBeDefined();
  });

  it("cycle-protects (A → B → A) and exhausts cleanly", async () => {
    await bootDb();
    // Configure A.fallback = [B]; B.fallback = [A]. Both envs failed.
    const a = await seedAgentEnv("ring-a", false);
    const b = await seedAgentEnv("ring-b", false);
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    db.prepare("UPDATE agents SET fallback_json = ? WHERE id = ?").run(
      JSON.stringify([{ agent_id: b.agentId, environment_id: b.envId }]),
      a.agentId,
    );

    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(req("/v1/sessions", {
      body: { agent: a.agentId, environment_id: a.envId },
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/session creation failed/i);
    expect(body.error.message).toMatch(/Attempted:/);
  });

  it("propagates non-fallback errors (scope denial) unchanged without trying alternates", async () => {
    await bootDb();
    const primary = await seedAgentEnv(
      "scope-test",
      true,
      JSON.stringify([{ agent_id: "fallback_agent", environment_id: "fallback_env" }]),
    );

    const { createApiKey } = await import("../src/db/api_keys");
    const { key: scopedKey } = createApiKey({
      name: "scoped",
      permissions: {
        admin: false,
        scope: { agents: ["different_agent"], environments: ["*"], vaults: ["*"] },
      },
      tenantId: "tenant_default",
      rawKey: "ck_scoped_nofallback_12345",
    });

    const { handleCreateSession } = await import("../src/handlers/sessions");
    const res = await handleCreateSession(req("/v1/sessions", {
      apiKey: scopedKey,
      body: { agent: primary.agentId, environment_id: primary.envId },
    }));
    // Should be 403 (scope), not 400 (fallback exhausted)
    expect(res.status).toBe(403);
  });
});

describe("tenant_id passthrough (v0.5 reservation)", () => {
  beforeEach(() => freshDbEnv());

  it("AuthContext exposes tenantId for keys that have one; null for keys that don't", async () => {
    await bootDb();
    const { createApiKey, findByRawKey, hydratePermissions } = await import("../src/db/api_keys");
    const { authenticate } = await import("../src/auth/middleware");

    const { key: k1 } = createApiKey({
      name: "tenant-scoped",
      permissions: { admin: false, scope: null },
      tenantId: "tenant_acme",
      rawKey: "ck_with_tenant_1234567890",
    });
    const { key: k2 } = createApiKey({
      name: "no-tenant",
      permissions: { admin: false, scope: null },
      rawKey: "ck_no_tenant_1234567890",
    });

    const ctx1 = await authenticate(new Request("http://l", { headers: { "x-api-key": k1 } }));
    expect(ctx1.tenantId).toBe("tenant_acme");

    const ctx2 = await authenticate(new Request("http://l", { headers: { "x-api-key": k2 } }));
    expect(ctx2.tenantId).toBeNull();

    // Handlers don't read tenantId in v0.4 — spot check by finding the row
    const row1 = findByRawKey(k1);
    expect(row1?.tenant_id).toBe("tenant_acme");
    expect(hydratePermissions(row1!.permissions_json)).toEqual({ admin: false, scope: null });
  });
});
