/**
 * M5 crash-recovery test: a session row stuck in status='running' after a
 * server crash is swept on startup and flipped to status='idle' with
 * stop_reason='error', plus a session.error{server_restart} event and a
 * session.status_idle{stop_reason:"error"} event in that order.
 *
 * Calls `recoverStaleSessions()` directly rather than going through
 * `ensureInitialized()` so the test doesn't reboot the DB / seed the API
 * key / run orphan reconcile.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-crash-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
}

async function seedRunningSession(id: string): Promise<void> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();
  db.prepare(
    `INSERT INTO agents (id, current_version, name, created_at, updated_at)
     VALUES ('agent_c', 1, 't', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_versions
       (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
     VALUES ('agent_c', 1, 'm', NULL, '[]', '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, created_at)
     VALUES ('env_c', 't', '{}', 'ready', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, created_at, updated_at
     ) VALUES (?, 'agent_c', 1, 'env_c', 'running', NULL, '{}', 0, 0)`,
  ).run(id);
}

describe("crash recovery", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("flips a running session to idle with stop_reason=error + emits events", async () => {
    await seedRunningSession("sess_crash");

    const { recoverStaleSessions } = await import("../src/init");
    recoverStaleSessions();

    const { getDb } = await import("../src/db/client");
    const db = getDb();

    const row = db
      .prepare(
        `SELECT status, stop_reason FROM sessions WHERE id = ?`,
      )
      .get("sess_crash") as { status: string; stop_reason: string } | undefined;
    expect(row?.status).toBe("idle");
    expect(row?.stop_reason).toBe("error");

    const events = db
      .prepare(
        `SELECT type, payload_json, seq FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all("sess_crash") as { type: string; payload_json: string; seq: number }[];
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("session.error");
    expect(events[1].type).toBe("session.status_idle");

    const errorPayload = JSON.parse(events[0].payload_json) as {
      error: { type: string; message: string };
    };
    expect(errorPayload.error.type).toBe("server_restart");

    const idlePayload = JSON.parse(events[1].payload_json) as { stop_reason: { type: string } };
    expect(idlePayload.stop_reason).toEqual({ type: "error" });
  });

  it("no-op when there are no running sessions", async () => {
    const { getDb } = await import("../src/db/client");
    getDb(); // bootstrap migrations

    const { recoverStaleSessions } = await import("../src/init");
    recoverStaleSessions();

    // No error. Nothing to assert beyond "does not throw".
  });
});
