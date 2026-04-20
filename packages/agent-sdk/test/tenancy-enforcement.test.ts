/**
 * v0.5 tenant enforcement across handlers.
 *
 * Covers the "no cross-tenant visibility" guarantees that PR1b wires up:
 *   - Tenant users only see their own tenant's resources in list endpoints.
 *   - GET/PATCH/DELETE by id return 404 (not 403) for cross-tenant ids.
 *   - Session create stamps tenant_id from the agent/env tenant and
 *     refuses cross-tenant agent+env pairs with a 400.
 *   - Global admin (null tenant + admin) sees everything.
 *
 * A new tenant ("tenant_acme") is created alongside the default tenant;
 * one admin key is minted into each and we exercise both.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-tenancy-enf-test-"));
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

interface TestKeys {
  globalKey: string;
  globalId: string;
  acmeAdminKey: string;
  acmeAdminId: string;
}

async function bootTenants(): Promise<TestKeys> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { seedDefaultTenant, createTenant } = await import("../src/db/tenants");
  const { createApiKey } = await import("../src/db/api_keys");

  seedDefaultTenant();
  createTenant({ id: "tenant_acme", name: "acme" });

  // Global admin — tenant_id = null, admin = true.
  const global = createApiKey({
    name: "global-admin",
    permissions: { admin: true, scope: null },
    tenantId: null,
    rawKey: "ck_test_global_admin_0001",
  });

  // Tenant admin for the acme tenant — tenant_id = tenant_acme, admin = true.
  const acme = createApiKey({
    name: "acme-admin",
    permissions: { admin: true, scope: null },
    tenantId: "tenant_acme",
    rawKey: "ck_test_acme_admin_0001",
  });

  return {
    globalKey: global.key,
    globalId: global.id,
    acmeAdminKey: acme.key,
    acmeAdminId: acme.id,
  };
}

function req(
  url: string,
  apiKey: string,
  opts: { method?: string; body?: unknown } = {},
): Request {
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("v0.5 tenant enforcement — agents", () => {
  beforeEach(() => freshDbEnv());

  it("list + get + patch + delete are scoped to caller's tenant", async () => {
    const { globalKey, acmeAdminKey } = await bootTenants();
    const { handleCreateAgent, handleListAgents, handleGetAgent, handleUpdateAgent, handleDeleteAgent } =
      await import("../src/handlers/agents");

    // Global admin creates one agent in each tenant.
    const defRes = await handleCreateAgent(
      req("/v1/agents", globalKey, {
        body: { name: "default-a", model: "claude-sonnet-4-6", tenant_id: "tenant_default" },
      }),
    );
    expect(defRes.status).toBe(201);
    const defAgent = await readJson(defRes);

    const acmeRes = await handleCreateAgent(
      req("/v1/agents", globalKey, {
        body: { name: "acme-a", model: "claude-sonnet-4-6", tenant_id: "tenant_acme" },
      }),
    );
    expect(acmeRes.status).toBe(201);
    const acmeAgent = await readJson(acmeRes);

    // Global admin sees both.
    const allList = await readJson(
      await handleListAgents(req("/v1/agents", globalKey)),
    );
    const allIds = (allList.data as Array<{ id: string }>).map(a => a.id);
    expect(allIds).toContain(defAgent.id);
    expect(allIds).toContain(acmeAgent.id);

    // Acme admin sees only their tenant's agent.
    const acmeList = await readJson(
      await handleListAgents(req("/v1/agents", acmeAdminKey)),
    );
    const acmeIds = (acmeList.data as Array<{ id: string }>).map(a => a.id);
    expect(acmeIds).toContain(acmeAgent.id);
    expect(acmeIds).not.toContain(defAgent.id);

    // Acme admin can't fetch default-tenant agent — 404 (not 403) to
    // prevent id-probing across tenants.
    const crossGet = await handleGetAgent(
      req(`/v1/agents/${defAgent.id}`, acmeAdminKey),
      defAgent.id as string,
    );
    expect(crossGet.status).toBe(404);

    // Cross-tenant patch → 404.
    const crossPatch = await handleUpdateAgent(
      req(`/v1/agents/${defAgent.id}`, acmeAdminKey, { body: { name: "stolen" } }),
      defAgent.id as string,
    );
    expect(crossPatch.status).toBe(404);

    // Cross-tenant delete → 404.
    const crossDel = await handleDeleteAgent(
      req(`/v1/agents/${defAgent.id}`, acmeAdminKey, { method: "DELETE" }),
      defAgent.id as string,
    );
    expect(crossDel.status).toBe(404);
  });

  it("tenant user cannot create an agent in another tenant", async () => {
    const { acmeAdminKey } = await bootTenants();
    const { handleCreateAgent, handleListAgents } = await import("../src/handlers/agents");

    // Body tenant_id is ignored for tenant users — their own tenant always wins.
    const res = await handleCreateAgent(
      req("/v1/agents", acmeAdminKey, {
        body: { name: "still-acme", model: "claude-sonnet-4-6", tenant_id: "tenant_default" },
      }),
    );
    expect(res.status).toBe(201);

    // Now verify: the default-tenant admin should not see this agent.
    const { createApiKey } = await import("../src/db/api_keys");
    const def = createApiKey({
      name: "default-admin",
      permissions: { admin: true, scope: null },
      tenantId: "tenant_default",
      rawKey: "ck_test_default_admin_0001",
    });
    const defList = await readJson(
      await handleListAgents(req("/v1/agents", def.key)),
    );
    const names = (defList.data as Array<{ name: string }>).map(a => a.name);
    expect(names).not.toContain("still-acme");
  });
});

describe("v0.5 tenant enforcement — environments", () => {
  beforeEach(() => freshDbEnv());

  it("list + get are scoped; cross-tenant get → 404", async () => {
    const { globalKey, acmeAdminKey } = await bootTenants();
    const { handleListEnvironments, handleGetEnvironment } = await import(
      "../src/handlers/environments"
    );
    // Seed env rows directly in each tenant to avoid provider checks.
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");
    const db = getDb();
    const defEnvId = newId("env");
    const acmeEnvId = newId("env");
    const now = nowMs();
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES (?, 'def-env', '{"type":"cloud","provider":"docker"}', 'ready', 'tenant_default', ?)`,
    ).run(defEnvId, now);
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES (?, 'acme-env', '{"type":"cloud","provider":"docker"}', 'ready', 'tenant_acme', ?)`,
    ).run(acmeEnvId, now);

    // Global admin sees both.
    const all = await readJson(
      await handleListEnvironments(req("/v1/environments", globalKey)),
    );
    const allIds = (all.data as Array<{ id: string }>).map(e => e.id);
    expect(allIds).toContain(defEnvId);
    expect(allIds).toContain(acmeEnvId);

    // Acme admin sees only their tenant.
    const acme = await readJson(
      await handleListEnvironments(req("/v1/environments", acmeAdminKey)),
    );
    const acmeIds = (acme.data as Array<{ id: string }>).map(e => e.id);
    expect(acmeIds).toContain(acmeEnvId);
    expect(acmeIds).not.toContain(defEnvId);

    // Acme admin cross-tenant GET → 404.
    const crossGet = await handleGetEnvironment(
      req(`/v1/environments/${defEnvId}`, acmeAdminKey),
      defEnvId,
    );
    expect(crossGet.status).toBe(404);
  });
});

describe("v0.5 tenant enforcement — sessions", () => {
  beforeEach(() => freshDbEnv());

  it("cross-tenant agent + env is refused with 400", async () => {
    const { globalKey } = await bootTenants();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");

    // Agent in default tenant, env in acme tenant — both created by the
    // global admin who can pick tenants.
    const agentRes = await handleCreateAgent(
      req("/v1/agents", globalKey, {
        body: { name: "cross-a", model: "claude-sonnet-4-6", tenant_id: "tenant_default" },
      }),
    );
    const agent = await readJson(agentRes);

    const envId = newId("env");
    getDb()
      .prepare(
        `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
         VALUES (?, 'other-env', '{"type":"cloud","provider":"docker"}', 'ready', 'tenant_acme', ?)`,
      )
      .run(envId, nowMs());

    const res = await handleCreateSession(
      req("/v1/sessions", globalKey, {
        body: { agent: agent.id, environment_id: envId },
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    const err = body.error as { message: string };
    expect(err.message).toMatch(/different tenants/);
  });

  it("session create stamps tenant_id from the agent/env tenant", async () => {
    const { acmeAdminKey } = await bootTenants();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const { handleCreateSession, handleListSessions } = await import(
      "../src/handlers/sessions"
    );
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");

    const agentRes = await handleCreateAgent(
      req("/v1/agents", acmeAdminKey, {
        body: { name: "acme-agent", model: "claude-sonnet-4-6" },
      }),
    );
    const agent = await readJson(agentRes);

    const envId = newId("env");
    getDb()
      .prepare(
        `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
         VALUES (?, 'acme-env', '{"type":"cloud","provider":"docker"}', 'ready', 'tenant_acme', ?)`,
      )
      .run(envId, nowMs());

    const createRes = await handleCreateSession(
      req("/v1/sessions", acmeAdminKey, {
        body: { agent: agent.id, environment_id: envId },
      }),
    );
    expect(createRes.status).toBe(201);
    const session = await readJson(createRes);

    // Row-level check: tenant_id stamped onto sessions row.
    const row = getDb()
      .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
      .get(session.id) as { tenant_id: string | null };
    expect(row.tenant_id).toBe("tenant_acme");

    // A default-tenant admin should NOT see this session.
    const { createApiKey } = await import("../src/db/api_keys");
    const def = createApiKey({
      name: "default-admin",
      permissions: { admin: true, scope: null },
      tenantId: "tenant_default",
      rawKey: "ck_test_default_admin_sess",
    });
    const defList = await readJson(
      await handleListSessions(req("/v1/sessions", def.key)),
    );
    const defIds = (defList.data as Array<{ id: string }>).map(s => s.id);
    expect(defIds).not.toContain(session.id);
  });
});

describe("v0.5 tenant enforcement — session fallback", () => {
  beforeEach(() => freshDbEnv());

  it("cross-tenant fallback tuples are silently skipped", async () => {
    const { globalKey } = await bootTenants();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");

    // Primary agent + primary env in default tenant.
    const primaryAgent = await readJson(
      await handleCreateAgent(
        req("/v1/agents", globalKey, {
          body: { name: "primary", model: "claude-sonnet-4-6", tenant_id: "tenant_default" },
        }),
      ),
    );

    const primaryEnvId = newId("env");
    const acmeEnvId = newId("env");
    const acmeAgentId = newId("agent");
    const acmeAgentVer = 1;
    const now = nowMs();
    const db = getDb();

    // Primary env — broken (state="error") so fallback is forced.
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES (?, 'primary-env', '{"type":"cloud","provider":"docker"}', 'error', 'tenant_default', ?)`,
    ).run(primaryEnvId, now);

    // Acme tenant env (cross-tenant — should be skipped as fallback).
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES (?, 'acme-env', '{"type":"cloud","provider":"docker"}', 'ready', 'tenant_acme', ?)`,
    ).run(acmeEnvId, now);

    // Acme tenant agent (cross-tenant — should be skipped).
    db.prepare(
      `INSERT INTO agents (id, current_version, name, tenant_id, created_at, updated_at)
       VALUES (?, ?, 'acme-agent', 'tenant_acme', ?, ?)`,
    ).run(acmeAgentId, acmeAgentVer, now, now);
    db.prepare(
      `INSERT INTO agent_versions (agent_id, version, model, tools_json, mcp_servers_json, backend, created_at)
       VALUES (?, ?, 'claude-sonnet-4-6', '[]', '{}', 'claude', ?)`,
    ).run(acmeAgentId, acmeAgentVer, now);

    // Configure primary agent with a cross-tenant fallback only.
    const fallbackJson = JSON.stringify([
      { agent_id: acmeAgentId, environment_id: acmeEnvId },
    ]);
    db.prepare(`UPDATE agents SET fallback_json = ? WHERE id = ?`).run(fallbackJson, primaryAgent.id);

    // Creating a session should fail — primary env is broken (state=error)
    // so `tryCreate` throws "environment is not ready" (which is normally
    // retryable), and the only fallback is cross-tenant and gets skipped.
    const res = await handleCreateSession(
      req("/v1/sessions", globalKey, {
        body: { agent: primaryAgent.id, environment_id: primaryEnvId },
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    const err = body.error as { message: string };
    expect(err.message).toMatch(/Skipped cross-tenant fallbacks/);
    expect(err.message).toMatch(new RegExp(acmeAgentId));
  });

  it("fallback pointing at a deleted agent/env surfaces a 'not found' reason", async () => {
    // P1-3: distinguish "fallback row was deleted" from "fallback is in
    // another tenant". Before the fix, both landed in the same bucket
    // with the "different tenant" message, misleading the operator.
    const { globalKey } = await bootTenants();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");

    const primary = await readJson(
      await handleCreateAgent(
        req("/v1/agents", globalKey, {
          body: { name: "has-stale-fallback", model: "claude-sonnet-4-6", tenant_id: "tenant_default" },
        }),
      ),
    );
    const primaryEnvId = newId("env");
    getDb().prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES (?, 'env', '{"type":"cloud","provider":"docker"}', 'error', 'tenant_default', ?)`,
    ).run(primaryEnvId, nowMs());

    // Fallback references rows that don't exist anywhere.
    const fallbackJson = JSON.stringify([
      { agent_id: "agent_deleted_at_some_point", environment_id: "env_also_gone" },
    ]);
    getDb().prepare(`UPDATE agents SET fallback_json = ? WHERE id = ?`)
      .run(fallbackJson, primary.id);

    const res = await handleCreateSession(
      req("/v1/sessions", globalKey, {
        body: { agent: primary.id, environment_id: primaryEnvId },
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson(res);
    const err = body.error as { message: string };
    expect(err.message).toMatch(/fallback agent not found/);
  });

  it("same-tenant fallback still works", async () => {
    const { acmeAdminKey } = await bootTenants();
    const { handleCreateAgent } = await import("../src/handlers/agents");
    const { handleCreateSession } = await import("../src/handlers/sessions");
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");

    const primary = await readJson(
      await handleCreateAgent(
        req("/v1/agents", acmeAdminKey, {
          body: { name: "primary", model: "claude-sonnet-4-6" },
        }),
      ),
    );
    const backup = await readJson(
      await handleCreateAgent(
        req("/v1/agents", acmeAdminKey, {
          body: { name: "backup", model: "claude-sonnet-4-6" },
        }),
      ),
    );

    const brokenEnv = newId("env");
    const healthyEnv = newId("env");
    const now = nowMs();
    const db = getDb();
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES (?, 'broken', '{"type":"cloud","provider":"docker"}', 'error', 'tenant_acme', ?)`,
    ).run(brokenEnv, now);
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES (?, 'healthy', '{"type":"cloud","provider":"docker"}', 'ready', 'tenant_acme', ?)`,
    ).run(healthyEnv, now);

    // Primary agent falls back to backup/healthy within the same tenant.
    db.prepare(`UPDATE agents SET fallback_json = ? WHERE id = ?`).run(
      JSON.stringify([{ agent_id: backup.id, environment_id: healthyEnv }]),
      primary.id,
    );

    const res = await handleCreateSession(
      req("/v1/sessions", acmeAdminKey, {
        body: { agent: primary.id, environment_id: brokenEnv },
      }),
    );
    expect(res.status).toBe(201);
    const session = await readJson(res);
    expect((session.agent as { id: string }).id).toBe(backup.id);
    expect(session.environment_id).toBe(healthyEnv);
  });
});

describe("v0.5 tenant enforcement — upstream-key pool (global-admin only)", () => {
  beforeEach(() => freshDbEnv());

  it("tenant admin cannot list, add, or delete pool entries", async () => {
    const { acmeAdminKey } = await bootTenants();
    const {
      handleAddUpstreamKey, handleListUpstreamKeys,
      handleGetUpstreamKey, handlePatchUpstreamKey, handleDeleteUpstreamKey,
    } = await import("../src/handlers/upstream_keys");

    const listRes = await handleListUpstreamKeys(req("/v1/upstream-keys", acmeAdminKey));
    expect(listRes.status).toBe(403);

    const addRes = await handleAddUpstreamKey(req("/v1/upstream-keys", acmeAdminKey, {
      body: { provider: "anthropic", value: "sk-ant-api03-tenant-admin-cannot-add-padding" },
    }));
    expect(addRes.status).toBe(403);

    const getRes = await handleGetUpstreamKey(
      req("/v1/upstream-keys/ukey_something", acmeAdminKey), "ukey_something",
    );
    expect(getRes.status).toBe(403);

    const patchRes = await handlePatchUpstreamKey(
      req("/v1/upstream-keys/ukey_something", acmeAdminKey, { method: "PATCH", body: { disabled: true } }),
      "ukey_something",
    );
    expect(patchRes.status).toBe(403);

    const delRes = await handleDeleteUpstreamKey(
      req("/v1/upstream-keys/ukey_something", acmeAdminKey, { method: "DELETE" }),
      "ukey_something",
    );
    expect(delRes.status).toBe(403);
  });

  it("global admin can add + list; audit entries land under null tenant", async () => {
    const { globalKey } = await bootTenants();
    const {
      handleAddUpstreamKey, handleListUpstreamKeys,
    } = await import("../src/handlers/upstream_keys");
    const { listAudit } = await import("../src/db/audit");

    const addRes = await handleAddUpstreamKey(req("/v1/upstream-keys", globalKey, {
      body: { provider: "anthropic", value: "sk-ant-api03-global-admin-add-padding" },
    }));
    expect(addRes.status).toBe(201);

    const listRes = await handleListUpstreamKeys(req("/v1/upstream-keys", globalKey));
    expect(listRes.status).toBe(200);

    // The pool is global — audit entries should be tenant_id=null, not
    // bucketed under the acting admin's (also null) tenant by accident.
    const entries = listAudit({ action: "upstream_keys.add" });
    expect(entries).toHaveLength(1);
    expect(entries[0].tenant_id).toBeNull();
  });
});

describe("v0.5 tenant enforcement — proxied (Anthropic backend) sessions", () => {
  beforeEach(() => freshDbEnv());

  it("pure-proxy session id from another tenant returns 404 on get/delete/stream", async () => {
    // Stamp two proxy-only sessions directly (one per tenant) — the
    // handler path expects proxy_resources rows, so seeding the table
    // is sufficient to reproduce the pure-proxy shape.
    const { globalKey, acmeAdminKey } = await bootTenants();
    const { markProxied } = await import("../src/db/proxy");

    markProxied("sess_proxy_default", "session", "tenant_default");
    markProxied("sess_proxy_acme",    "session", "tenant_acme");

    const { handleGetSession, handleDeleteSession, handleArchiveSession } =
      await import("../src/handlers/sessions");
    const { handleSessionStream } = await import("../src/handlers/stream");

    // Acme admin trying to access tenant_default's proxy session: 404
    // (not 403) so there's no id-existence probe.
    const getRes = await handleGetSession(
      req("/v1/sessions/sess_proxy_default", acmeAdminKey), "sess_proxy_default",
    );
    expect(getRes.status).toBe(404);

    const delRes = await handleDeleteSession(
      req("/v1/sessions/sess_proxy_default", acmeAdminKey, { method: "DELETE" }),
      "sess_proxy_default",
    );
    expect(delRes.status).toBe(404);

    const archRes = await handleArchiveSession(
      req("/v1/sessions/sess_proxy_default/archive", acmeAdminKey, { method: "POST" }),
      "sess_proxy_default",
    );
    expect(archRes.status).toBe(404);

    const streamRes = await handleSessionStream(
      req("/v1/sessions/sess_proxy_default/stream", acmeAdminKey),
      "sess_proxy_default",
    );
    expect(streamRes.status).toBe(404);

    // Global admin is fine (will forward upstream — this test doesn't
    // stub that; we just assert the tenant gate doesn't block).
    // Skipping the forward call to avoid a network dependency.
    void globalKey;
  });

  it("proxy agent/env with another tenant returns 404 on get", async () => {
    const { acmeAdminKey } = await bootTenants();
    const { markProxied } = await import("../src/db/proxy");

    markProxied("agent_proxy_default", "agent", "tenant_default");
    markProxied("env_proxy_default", "environment", "tenant_default");

    const { handleGetAgent } = await import("../src/handlers/agents");
    const { handleGetEnvironment } = await import("../src/handlers/environments");

    const a = await handleGetAgent(
      req("/v1/agents/agent_proxy_default", acmeAdminKey), "agent_proxy_default",
    );
    expect(a.status).toBe(404);

    const e = await handleGetEnvironment(
      req("/v1/environments/env_proxy_default", acmeAdminKey), "env_proxy_default",
    );
    expect(e.status).toBe(404);
  });
});

describe("v0.5 tenant enforcement — metrics endpoints", () => {
  beforeEach(() => freshDbEnv());

  it("/v1/metrics?group_by=agent returns only the caller's tenant's rows", async () => {
    const { globalKey, acmeAdminKey } = await bootTenants();
    const { getDb } = await import("../src/db/client");
    const { nowMs } = await import("../src/util/clock");
    const { handleGetMetrics } = await import("../src/handlers/metrics");

    const db = getDb();
    const now = nowMs();
    db.prepare(
      `INSERT INTO agents (id, current_version, name, tenant_id, created_at, updated_at)
       VALUES ('agent_def', 1, 'def', 'tenant_default', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO agents (id, current_version, name, tenant_id, created_at, updated_at)
       VALUES ('agent_acme', 1, 'acme', 'tenant_acme', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO agent_versions (agent_id, version, model, tools_json, mcp_servers_json, backend, webhook_events_json, skills_json, model_config_json, created_at)
       VALUES ('agent_def', 1, 'claude-sonnet-4-6', '[]', '{}', 'claude', '[]', '[]', '{}', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO agent_versions (agent_id, version, model, tools_json, mcp_servers_json, backend, webhook_events_json, skills_json, model_config_json, created_at)
       VALUES ('agent_acme', 1, 'claude-sonnet-4-6', '[]', '{}', 'claude', '[]', '[]', '{}', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES ('env_def', 'def', '{}', 'ready', 'tenant_default', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES ('env_acme', 'acme', '{}', 'ready', 'tenant_acme', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, tenant_id, created_at, updated_at)
       VALUES ('sess_def', 'agent_def', 1, 'env_def', 'idle', '{}', 'tenant_default', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, tenant_id, created_at, updated_at)
       VALUES ('sess_acme', 'agent_acme', 1, 'env_acme', 'idle', '{}', 'tenant_acme', ?, ?)`,
    ).run(now, now);

    const globalRes = await handleGetMetrics(req("/v1/metrics?group_by=agent", globalKey));
    const globalBody = await readJson(globalRes);
    const globalKeys = (globalBody.groups as Array<{ key: string }>).map(g => g.key).sort();
    expect(globalKeys).toEqual(["agent_acme", "agent_def"]);

    const acmeRes = await handleGetMetrics(req("/v1/metrics?group_by=agent", acmeAdminKey));
    const acmeBody = await readJson(acmeRes);
    const acmeKeys = (acmeBody.groups as Array<{ key: string }>).map(g => g.key);
    expect(acmeKeys).toEqual(["agent_acme"]);
  });

  it("/v1/metrics/api is 403 for non-global-admin callers", async () => {
    const { acmeAdminKey } = await bootTenants();
    const { handleGetApiMetrics } = await import("../src/handlers/metrics");
    const res = await handleGetApiMetrics(req("/v1/metrics/api", acmeAdminKey));
    expect(res.status).toBe(403);
  });
});

describe("v0.5 tenant enforcement — session-scoped subresources", () => {
  beforeEach(() => freshDbEnv());

  async function seedSession(tenantId: string): Promise<string> {
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");
    const db = getDb();
    const now = nowMs();
    const id = newId("sess");
    const aid = newId("agent");
    const eid = newId("env");
    db.prepare(
      `INSERT INTO agents (id, current_version, name, tenant_id, created_at, updated_at)
       VALUES (?, 1, 'a', ?, ?, ?)`,
    ).run(aid, tenantId, now, now);
    db.prepare(
      `INSERT INTO agent_versions (agent_id, version, model, tools_json, mcp_servers_json, backend, webhook_events_json, skills_json, model_config_json, created_at)
       VALUES (?, 1, 'claude-sonnet-4-6', '[]', '{}', 'claude', '[]', '[]', '{}', ?)`,
    ).run(aid, now);
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
       VALUES (?, 'e', '{}', 'ready', ?, ?)`,
    ).run(eid, tenantId, now);
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, tenant_id, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'idle', '{}', ?, ?, ?)`,
    ).run(id, aid, eid, tenantId, now, now);
    return id;
  }

  it("events POST + list from another tenant returns 404", async () => {
    const { acmeAdminKey } = await bootTenants();
    const sess = await seedSession("tenant_default");

    const { handlePostEvents, handleListEvents } = await import("../src/handlers/events");

    const postRes = await handlePostEvents(
      req(`/v1/sessions/${sess}/events`, acmeAdminKey, {
        body: { events: [{ type: "user.interrupt" }] },
      }),
      sess,
    );
    expect(postRes.status).toBe(404);

    const listRes = await handleListEvents(
      req(`/v1/sessions/${sess}/events`, acmeAdminKey),
      sess,
    );
    expect(listRes.status).toBe(404);
  });

  it("stream from another tenant returns 404", async () => {
    const { acmeAdminKey } = await bootTenants();
    const sess = await seedSession("tenant_default");
    const { handleSessionStream } = await import("../src/handlers/stream");
    const res = await handleSessionStream(
      req(`/v1/sessions/${sess}/stream`, acmeAdminKey),
      sess,
    );
    expect(res.status).toBe(404);
  });

  it("resources from another tenant returns 404", async () => {
    const { acmeAdminKey } = await bootTenants();
    const sess = await seedSession("tenant_default");
    const { handleAddResource, handleListResources } = await import("../src/handlers/resources");
    const listRes = await handleListResources(
      req(`/v1/sessions/${sess}/resources`, acmeAdminKey),
      sess,
    );
    expect(listRes.status).toBe(404);
    const addRes = await handleAddResource(
      req(`/v1/sessions/${sess}/resources`, acmeAdminKey, {
        body: { type: "uri", uri: "https://x" },
      }),
      sess,
    );
    expect(addRes.status).toBe(404);
  });

  it("threads from another tenant returns 404", async () => {
    const { acmeAdminKey } = await bootTenants();
    const sess = await seedSession("tenant_default");
    const { handleListThreads } = await import("../src/handlers/threads");
    const res = await handleListThreads(
      req(`/v1/sessions/${sess}/threads`, acmeAdminKey),
      sess,
    );
    expect(res.status).toBe(404);
  });

  it("files scope_id from another tenant returns 404", async () => {
    const { acmeAdminKey } = await bootTenants();
    const sess = await seedSession("tenant_default");
    const { handleListFiles } = await import("../src/handlers/files");
    const res = await handleListFiles(
      req(`/v1/files?scope_id=${sess}`, acmeAdminKey),
    );
    expect(res.status).toBe(404);
  });
});

describe("v0.5 /v1/whoami", () => {
  beforeEach(() => freshDbEnv());

  it("global admin sees is_global_admin=true, tenant_id=null", async () => {
    const { globalKey } = await bootTenants();
    const { handleWhoami } = await import("../src/handlers/whoami");
    const res = await handleWhoami(req("/v1/whoami", globalKey));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.is_global_admin).toBe(true);
    expect(body.tenant_id).toBeNull();
  });

  it("tenant admin sees their tenant_id and is_global_admin=false", async () => {
    const { acmeAdminKey } = await bootTenants();
    const { handleWhoami } = await import("../src/handlers/whoami");
    const res = await handleWhoami(req("/v1/whoami", acmeAdminKey));
    const body = await readJson(res);
    expect(body.is_global_admin).toBe(false);
    expect(body.tenant_id).toBe("tenant_acme");
  });
});

describe("v0.5 tenant enforcement — api keys", () => {
  beforeEach(() => freshDbEnv());

  it("list is tenant-scoped; global admin sees all, tenant admin only own", async () => {
    const { globalKey, globalId, acmeAdminKey, acmeAdminId } = await bootTenants();
    const { handleListApiKeys } = await import("../src/handlers/api_keys");

    // Global admin: returns both keys (global-admin itself + acme-admin).
    const all = await readJson(await handleListApiKeys(req("/v1/api-keys", globalKey)));
    const allIds = (all.data as Array<{ id: string }>).map(r => r.id);
    expect(allIds).toContain(globalId);
    expect(allIds).toContain(acmeAdminId);

    // Acme admin: only the acme key shows up. Global-admin key (tenant=null)
    // is invisible to tenant users.
    const scoped = await readJson(await handleListApiKeys(req("/v1/api-keys", acmeAdminKey)));
    const scopedIds = (scoped.data as Array<{ id: string }>).map(r => r.id);
    expect(scopedIds).toContain(acmeAdminId);
    expect(scopedIds).not.toContain(globalId);
  });

  it("tenant admin cannot GET/PATCH/REVOKE another tenant's key (404)", async () => {
    const { globalId, acmeAdminKey } = await bootTenants();
    const { handleGetApiKey, handlePatchApiKey, handleRevokeApiKey } = await import(
      "../src/handlers/api_keys"
    );

    const get = await handleGetApiKey(
      req(`/v1/api-keys/${globalId}`, acmeAdminKey),
      globalId,
    );
    expect(get.status).toBe(404);

    const patch = await handlePatchApiKey(
      req(`/v1/api-keys/${globalId}`, acmeAdminKey, {
        method: "PATCH",
        body: { permissions: { admin: false, scope: null } },
      }),
      globalId,
    );
    expect(patch.status).toBe(404);

    const rev = await handleRevokeApiKey(
      req(`/v1/api-keys/${globalId}`, acmeAdminKey, { method: "DELETE" }),
      globalId,
    );
    expect(rev.status).toBe(404);
  });
});
