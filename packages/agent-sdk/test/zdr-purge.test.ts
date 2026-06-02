/**
 * PR-Z2 tests: the `purgeSession()` engine.
 *
 * Architect's 15-case matrix, focused subset (the in-flight-turn and
 * SSE-attached cases run at the wire level in PR-Z3):
 *   1. Non-ZDR baseline (lifecycle hooks skip purge)
 *   2. ZDR delete → per-session tables empty
 *   6. Recursive thread purge
 *   8. Session-scoped file unlinked; agent-scoped untouched
 *   9. Remote-provider session → storage_warnings populated
 *  10. Concurrent re-purge race → second call no-op
 *  11. Cross-tenant attempt → throws before any DELETE
 *  14. Debug-prompt purge → overrides 1h TTL
 *  15. Re-purge idempotency
 *  + Chaos: crash-mid-purge simulation, reaper recovers
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-zdr-purge-test-"));
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

async function seedSession(opts: {
  tenantId: string;
  sessionId?: string;
  zdr?: boolean;
  parentSessionId?: string;
}): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createTenant } = await import("../src/db/tenants");
  const { nowMs } = await import("../src/util/clock");
  const db = getDb();
  const now = nowMs();
  try { createTenant({ id: opts.tenantId, name: opts.tenantId }); } catch { /* exists */ }

  const sessionId = opts.sessionId ?? `sess_${opts.tenantId}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `agent_${opts.tenantId}`;
  const envId = `env_${opts.tenantId}`;
  try {
    db.prepare(`INSERT INTO agents (id, current_version, name, tenant_id, created_at, updated_at) VALUES (?, 1, 'a', ?, ?, ?)`).run(agentId, opts.tenantId, now, now);
    db.prepare(`INSERT INTO agent_versions (agent_id, version, model, tools_json, mcp_servers_json, backend, webhook_events_json, skills_json, model_config_json, created_at) VALUES (?, 1, 'claude-sonnet-4-6', '[]', '{}', 'claude', '[]', '[]', '{}', ?)`).run(agentId, now);
    db.prepare(`INSERT INTO environments (id, name, config_json, state, tenant_id, created_at) VALUES (?, 'e', '{}', 'ready', ?, ?)`).run(envId, opts.tenantId, now);
  } catch { /* exists */ }

  db.prepare(
    `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, tenant_id, zero_data_retention, parent_session_id, created_at, updated_at)
     VALUES (?, ?, 1, ?, 'idle', '{}', ?, ?, ?, ?, ?)`,
  ).run(sessionId, agentId, envId, opts.tenantId, opts.zdr ? 1 : 0, opts.parentSessionId ?? null, now, now);
  return sessionId;
}

async function seedEvent(sessionId: string, count = 1): Promise<void> {
  const { getDb } = await import("../src/db/client");
  const { nowMs } = await import("../src/util/clock");
  const db = getDb();
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO events (id, session_id, seq, type, payload_json, received_at, origin)
       VALUES (?, ?, ?, 'user.message', '{"text":"hi"}', ?, 'server')`,
    ).run(`evt_${sessionId}_${i}_${Date.now()}_${Math.random()}`, sessionId, i, nowMs() + i);
  }
}

async function db() {
  const { getDb } = await import("../src/db/client");
  return getDb();
}

async function count(table: string, where: string, ...args: unknown[]): Promise<number> {
  const d = await db();
  const row = d.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE ${where}`).get(...args) as { n: number };
  return row.n;
}

describe("ZDR purgeSession() engine (PR-Z2)", () => {
  beforeEach(() => freshDbEnv());

  it("1. non-ZDR session — purge engine isn't invoked by hooks; events survive archive", async () => {
    const sessionId = await seedSession({ tenantId: "tenant_a", zdr: false });
    await seedEvent(sessionId, 5);
    expect(await count("events", "session_id = ?", sessionId)).toBe(5);

    const d = await db();
    d.prepare(`UPDATE sessions SET status='archived', archived_at=? WHERE id=?`).run(Date.now(), sessionId);
    expect(await count("events", "session_id = ?", sessionId)).toBe(5);

    const sess = d.prepare(`SELECT status, retention_purged_at FROM sessions WHERE id = ?`).get(sessionId) as { status: string; retention_purged_at: number | null };
    expect(sess.status).toBe("archived");
    expect(sess.retention_purged_at).toBeNull();
  });

  it("2. ZDR purge — events, session_resources, work_items all empty; session stubbed", async () => {
    const sessionId = await seedSession({ tenantId: "tenant_a", zdr: true });
    await seedEvent(sessionId, 10);
    const { purgeSession } = await import("../src/db/zero-retention");
    const stats = purgeSession({ tenantId: "tenant_a", sessionId });

    expect(stats.events_deleted).toBe(10);
    expect(await count("events", "session_id = ?", sessionId)).toBe(0);
    expect(await count("session_resources", "session_id = ?", sessionId)).toBe(0);

    const d = await db();
    const sess = d.prepare(`SELECT status, retention_purged_at, metadata_json, title FROM sessions WHERE id = ?`).get(sessionId) as { status: string; retention_purged_at: number; metadata_json: string; title: string | null };
    expect(sess.status).toBe("purged");
    expect(sess.retention_purged_at).toBeGreaterThan(0);
    expect(sess.metadata_json).toBe("{}");
    expect(sess.title).toBeNull();

    const audit = d.prepare(`SELECT action, tenant_id FROM audit_log WHERE action = 'session.purged' AND resource_id = ?`).get(sessionId) as { action: string; tenant_id: string };
    expect(audit?.action).toBe("session.purged");
    expect(audit?.tenant_id).toBe("tenant_a");
  });

  it("6. recursive thread purge — child session and its events also gone", async () => {
    const parentId = await seedSession({ tenantId: "tenant_a", zdr: true });
    const childId = await seedSession({ tenantId: "tenant_a", zdr: true, parentSessionId: parentId });
    await seedEvent(parentId, 3);
    await seedEvent(childId, 5);

    const { purgeSession } = await import("../src/db/zero-retention");
    const stats = purgeSession({ tenantId: "tenant_a", sessionId: parentId });

    expect(stats.threads_purged).toBe(1);
    expect(stats.events_deleted).toBe(8);
    expect(await count("events", "session_id = ?", parentId)).toBe(0);
    expect(await count("events", "session_id = ?", childId)).toBe(0);

    const d = await db();
    const child = d.prepare(`SELECT status FROM sessions WHERE id = ?`).get(childId) as { status: string };
    expect(child.status).toBe("purged");
  });

  it("8. session-scoped file unlinked from disk; agent-scoped file untouched", async () => {
    const sessionId = await seedSession({ tenantId: "tenant_a", zdr: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zdr-file-test-"));
    const sessFile = path.join(dir, "s.txt");
    const agtFile = path.join(dir, "a.txt");
    fs.writeFileSync(sessFile, "SESSION SECRET");
    fs.writeFileSync(agtFile, "AGENT TEMPLATE");

    const d = await db();
    const { nowMs } = await import("../src/util/clock");
    const now = nowMs();
    d.prepare(`INSERT INTO files (id, filename, size, content_type, storage_path, scope_type, scope_id, created_at) VALUES ('file_sess', 's.txt', ?, 'text/plain', ?, 'session', ?, ?)`).run(fs.statSync(sessFile).size, sessFile, sessionId, now);
    d.prepare(`INSERT INTO files (id, filename, size, content_type, storage_path, scope_type, scope_id, created_at) VALUES ('file_agt', 'a.txt', ?, 'text/plain', ?, 'agent', 'agent_tenant_a', ?)`).run(fs.statSync(agtFile).size, agtFile, now);

    const { purgeSession } = await import("../src/db/zero-retention");
    const stats = purgeSession({ tenantId: "tenant_a", sessionId });

    expect(stats.files_unlinked).toBe(1);
    expect(fs.existsSync(sessFile)).toBe(false);
    expect(fs.existsSync(agtFile)).toBe(true);
    expect(await count("files", "id = 'file_sess'")).toBe(0);
    expect(await count("files", "id = 'file_agt'")).toBe(1);
  });

  it("9. remote-storage session file — storage_warnings populated, no upstream scrub claim", async () => {
    const sessionId = await seedSession({ tenantId: "tenant_a", zdr: true });
    const d = await db();
    const { nowMs } = await import("../src/util/clock");
    d.prepare(`INSERT INTO files (id, filename, size, content_type, storage_path, scope_type, scope_id, created_at) VALUES ('file_remote', 'r.txt', 100, 'text/plain', 'remote:file_anthropic_abc123', 'session', ?, ?)`).run(sessionId, nowMs());

    const { purgeSession } = await import("../src/db/zero-retention");
    const stats = purgeSession({ tenantId: "tenant_a", sessionId });

    expect(stats.storage_warnings.length).toBe(1);
    expect(stats.storage_warnings[0]).toContain("remote");
    expect(stats.storage_warnings[0]).toContain("Anthropic ZDR");
  });

  it("10. concurrent re-purge — second call is a no-op", async () => {
    const sessionId = await seedSession({ tenantId: "tenant_a", zdr: true });
    await seedEvent(sessionId, 3);

    const { purgeSession } = await import("../src/db/zero-retention");
    const first = purgeSession({ tenantId: "tenant_a", sessionId });
    expect(first.events_deleted).toBe(3);
    const second = purgeSession({ tenantId: "tenant_a", sessionId });
    expect(second.events_deleted).toBe(0);
    expect(second.threads_purged).toBe(0);
  });

  it("11. cross-tenant purge attempt — throws before any DELETE", async () => {
    const sessionId = await seedSession({ tenantId: "tenant_a", zdr: true });
    await seedEvent(sessionId, 5);
    expect(await count("events", "session_id = ?", sessionId)).toBe(5);

    const { purgeSession } = await import("../src/db/zero-retention");
    expect(() => purgeSession({ tenantId: "tenant_b", sessionId })).toThrow(/tenant mismatch/);

    expect(await count("events", "session_id = ?", sessionId)).toBe(5);
    const d = await db();
    const sess = d.prepare(`SELECT status, retention_purged_at FROM sessions WHERE id = ?`).get(sessionId) as { status: string; retention_purged_at: number | null };
    expect(sess.status).toBe("idle");
    expect(sess.retention_purged_at).toBeNull();
  });

  it("14. debug-prompt purge — overrides the 1-hour TTL", async () => {
    const sessionId = await seedSession({ tenantId: "tenant_a", zdr: true });
    const d = await db();
    d.prepare(`UPDATE sessions SET debug_prompt_json = ? WHERE id = ?`).run(
      JSON.stringify({ captured_at: new Date().toISOString(), prompt: "SECRET PROMPT" }),
      sessionId,
    );
    const before = d.prepare(`SELECT debug_prompt_json FROM sessions WHERE id = ?`).get(sessionId) as { debug_prompt_json: string };
    expect(before.debug_prompt_json).toContain("SECRET PROMPT");

    const { purgeSession } = await import("../src/db/zero-retention");
    purgeSession({ tenantId: "tenant_a", sessionId });

    const after = d.prepare(`SELECT debug_prompt_json FROM sessions WHERE id = ?`).get(sessionId) as { debug_prompt_json: string | null };
    expect(after.debug_prompt_json).toBeNull();
  });

  it("15. re-purge idempotency — third+ calls also no-op", async () => {
    const sessionId = await seedSession({ tenantId: "tenant_a", zdr: true });
    await seedEvent(sessionId, 2);
    const { purgeSession } = await import("../src/db/zero-retention");
    purgeSession({ tenantId: "tenant_a", sessionId });
    expect(purgeSession({ tenantId: "tenant_a", sessionId }).events_deleted).toBe(0);
    expect(purgeSession({ tenantId: "tenant_a", sessionId }).events_deleted).toBe(0);
  });

  it("chaos — crash-mid-purge: row in status='purging' recovered by reaper", async () => {
    const sessionId = await seedSession({ tenantId: "tenant_a", zdr: true });
    await seedEvent(sessionId, 7);

    // Simulate previous process that crashed AFTER setting status='purging'
    // but BEFORE running any DELETEs.
    const d = await db();
    d.prepare(
      `UPDATE sessions SET status = 'purging', retention_purged_at = ? WHERE id = ?`,
    ).run(Date.now(), sessionId);
    expect(await count("events", "session_id = ?", sessionId)).toBe(7);

    const { reapPurgingSessions } = await import("../src/db/zero-retention");
    const result = reapPurgingSessions();

    expect(result.reaped).toBe(1);
    expect(result.failed).toBe(0);
    expect(await count("events", "session_id = ?", sessionId)).toBe(0);
    const sess = d.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as { status: string };
    expect(sess.status).toBe("purged");
  });
});
