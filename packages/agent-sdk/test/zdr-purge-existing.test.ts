/**
 * PR-Z3 tests: the retroactive `POST /environments/{id}/purge-existing`
 * admin handler. Two-step confirm: dry-run by default, actual purge
 * with body { confirm: true }.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-zdr-px-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.SKIP_ZDR_REAPER = "1";
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown; __caDrizzle?: unknown; __caInitialized?: unknown;
    __caInitPromise?: unknown; __caBusEmitters?: unknown;
    __caConfigCache?: unknown; __caRuntime?: unknown;
    __caSweeperHandle?: unknown; __caActors?: unknown; __caLicense?: unknown;
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

async function seed(opts: { sessionCount: number; envId?: string }): Promise<{
  envId: string;
  sessionIds: string[];
  globalAdminKey: string;
}> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createTenant } = await import("../src/db/tenants");
  const { createApiKey } = await import("../src/db/api_keys");
  const { nowMs } = await import("../src/util/clock");
  const db = getDb();
  const now = nowMs();
  try { createTenant({ id: "tenant_a", name: "tenant_a" }); } catch { /* exists */ }
  const envId = opts.envId ?? "env_px";
  db.prepare(`INSERT INTO agents (id, current_version, name, tenant_id, created_at, updated_at) VALUES ('agent_px', 1, 'a', 'tenant_a', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO agent_versions (agent_id, version, model, tools_json, mcp_servers_json, backend, webhook_events_json, skills_json, model_config_json, created_at) VALUES ('agent_px', 1, 'claude-sonnet-4-6', '[]', '{}', 'claude', '[]', '[]', '{}', ?)`).run(now);
  db.prepare(`INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, 'e', '{}', 'ready', 'tenant_a', ?)`).run(envId, now);
  const sessionIds: string[] = [];
  for (let i = 0; i < opts.sessionCount; i++) {
    const sid = `sess_px_${i}`;
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, tenant_id, zero_data_retention, created_at, updated_at)
       VALUES (?, 'agent_px', 1, ?, 'idle', '{}', 'tenant_a', 0, ?, ?)`,
    ).run(sid, envId, now, now);
    db.prepare(
      `INSERT INTO events (id, session_id, seq, type, payload_json, received_at, origin)
       VALUES (?, ?, 0, 'user.message', '{"text":"hi"}', ?, 'server')`,
    ).run(`evt_${sid}`, sid, now);
    sessionIds.push(sid);
  }
  const { key } = createApiKey({
    name: "ga",
    permissions: { admin: true, scope: null },
    rawKey: "ck_px_global_admin",
  });
  return { envId, sessionIds, globalAdminKey: key };
}

function req(apiKey: string, envId: string, body?: object): Request {
  return new Request(`http://localhost/v1/environments/${envId}/purge-existing`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : "",
  });
}

describe("POST /environments/{id}/purge-existing (PR-Z3)", () => {
  beforeEach(() => freshDbEnv());

  it("dry-run (no body) — reports session_count, makes no changes", async () => {
    const { sessionIds, globalAdminKey, envId } = await seed({ sessionCount: 4 });
    const { handlePurgeEnvironmentExisting } = await import(
      "../src/handlers/zero-retention"
    );

    const res = await handlePurgeEnvironmentExisting(
      req(globalAdminKey, envId),
      envId,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { type: string; session_count: number };
    expect(body.type).toBe("purge_existing_dry_run");
    expect(body.session_count).toBe(4);

    // No actual purge — events still present
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    for (const sid of sessionIds) {
      const n = (db.prepare(`SELECT COUNT(*) as n FROM events WHERE session_id = ?`).get(sid) as { n: number }).n;
      expect(n).toBe(1);
    }
  });

  it("confirm:true — purges every session in the env", async () => {
    const { sessionIds, globalAdminKey, envId } = await seed({ sessionCount: 3 });
    const { handlePurgeEnvironmentExisting } = await import(
      "../src/handlers/zero-retention"
    );

    const res = await handlePurgeEnvironmentExisting(
      req(globalAdminKey, envId, { confirm: true }),
      envId,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      type: string;
      purged_count: number;
      failed_count: number;
      stats: { events_deleted: number };
    };
    expect(body.type).toBe("purge_existing_result");
    expect(body.purged_count).toBe(3);
    expect(body.failed_count).toBe(0);
    expect(body.stats.events_deleted).toBe(3);

    // Sessions all stubbed
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    for (const sid of sessionIds) {
      const sess = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sid) as { status: string };
      expect(sess.status).toBe("purged");
      const n = (db.prepare(`SELECT COUNT(*) as n FROM events WHERE session_id = ?`).get(sid) as { n: number }).n;
      expect(n).toBe(0);
    }
  });

  it("non-global-admin caller — denied (requireGlobalAdmin)", async () => {
    const { envId } = await seed({ sessionCount: 1 });
    const { getDb } = await import("../src/db/client");
    getDb();
    const { createApiKey } = await import("../src/db/api_keys");
    const { key: tenantAdminKey } = createApiKey({
      name: "ta",
      permissions: { admin: true, scope: null },
      tenantId: "tenant_a",
      rawKey: "ck_px_tenant_admin",
    });

    const { handlePurgeEnvironmentExisting } = await import(
      "../src/handlers/zero-retention"
    );
    const res = await handlePurgeEnvironmentExisting(
      req(tenantAdminKey, envId, { confirm: true }),
      envId,
    );
    expect(res.status).toBe(403);
  });

  it("env not found — 404", async () => {
    const { globalAdminKey } = await seed({ sessionCount: 0 });
    const { handlePurgeEnvironmentExisting } = await import(
      "../src/handlers/zero-retention"
    );
    const res = await handlePurgeEnvironmentExisting(
      req(globalAdminKey, "env_does_not_exist", { confirm: true }),
      "env_does_not_exist",
    );
    expect(res.status).toBe(404);
  });
});
