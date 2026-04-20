import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-bus-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  // Force re-import of singleton client
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
}

beforeEach(() => {
  freshDbEnv();
});

describe("bus", () => {
  it("assigns monotonic per-session seq inside a transaction", async () => {
    const { getDb } = await import("../src/db/client");
    const { appendEvent, appendEventsBatch } = await import("../src/sessions/bus");
    const db = getDb();

    // Create the minimum set of rows needed for the foreign key on events→sessions
    db.prepare(
      `INSERT INTO agents (id, current_version, name, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)`,
    ).run("agent_t1", "t", 0, 0);
    db.prepare(
      `INSERT INTO agent_versions
         (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
       VALUES (?, 1, ?, ?, ?, ?, ?)`,
    ).run("agent_t1", "m", null, "[]", "{}", 0);
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, created_at)
       VALUES (?, ?, ?, 'ready', ?)`,
    ).run("env_t1", "t", "{}", 0);
    db.prepare(
      `INSERT INTO sessions (
         id, agent_id, agent_version, environment_id, status,
         title, metadata_json, created_at, updated_at
       ) VALUES ('sess_t1', 'agent_t1', 1, 'env_t1', 'idle', null, '{}', 0, 0)`,
    ).run();

    const r1 = appendEvent("sess_t1", {
      type: "user.message",
      payload: { content: [{ type: "text", text: "a" }] },
      origin: "user",
    });
    const r2 = appendEvent("sess_t1", {
      type: "user.message",
      payload: { content: [{ type: "text", text: "b" }] },
      origin: "user",
    });
    const batch = appendEventsBatch("sess_t1", [
      { type: "agent.message", payload: {}, origin: "server" },
      { type: "agent.message", payload: {}, origin: "server" },
    ]);

    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
    expect(batch.map((r) => r.seq)).toEqual([3, 4]);
  });

  it("dedupes by idempotency_key within a session", async () => {
    const { getDb } = await import("../src/db/client");
    const { appendEvent } = await import("../src/sessions/bus");
    const db = getDb();

    db.prepare(
      `INSERT INTO agents (id, current_version, name, created_at, updated_at)
       VALUES ('agent_t2', 1, 't', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO agent_versions (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
       VALUES ('agent_t2', 1, 'm', null, '[]', '{}', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, created_at)
       VALUES ('env_t2', 't', '{}', 'ready', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, title, metadata_json, created_at, updated_at)
       VALUES ('sess_t2', 'agent_t2', 1, 'env_t2', 'idle', null, '{}', 0, 0)`,
    ).run();

    const a = appendEvent("sess_t2", {
      type: "user.message",
      payload: {},
      origin: "user",
      idempotencyKey: "abc:0",
    });
    const b = appendEvent("sess_t2", {
      type: "user.message",
      payload: {},
      origin: "user",
      idempotencyKey: "abc:0",
    });
    expect(b.id).toBe(a.id);
    expect(b.seq).toBe(a.seq);
  });

  it("subscribe backfills history and then delivers live events", async () => {
    const { getDb } = await import("../src/db/client");
    const { appendEvent, subscribe } = await import("../src/sessions/bus");
    const db = getDb();

    db.prepare(
      `INSERT INTO agents (id, current_version, name, created_at, updated_at)
       VALUES ('agent_t3', 1, 't', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO agent_versions (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
       VALUES ('agent_t3', 1, 'm', null, '[]', '{}', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, created_at)
       VALUES ('env_t3', 't', '{}', 'ready', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, title, metadata_json, created_at, updated_at)
       VALUES ('sess_t3', 'agent_t3', 1, 'env_t3', 'idle', null, '{}', 0, 0)`,
    ).run();

    // Insert 3 events before anyone subscribes
    appendEvent("sess_t3", { type: "agent.message", payload: { n: 1 }, origin: "server" });
    appendEvent("sess_t3", { type: "agent.message", payload: { n: 2 }, origin: "server" });
    appendEvent("sess_t3", { type: "agent.message", payload: { n: 3 }, origin: "server" });

    const received: number[] = [];
    const sub = subscribe("sess_t3", 1, (evt) => {
      received.push(evt.seq);
    });

    // Backfill should deliver seq 2,3 (fromSeq=1)
    expect(received).toEqual([2, 3]);

    // Live event
    appendEvent("sess_t3", { type: "agent.message", payload: { n: 4 }, origin: "server" });
    expect(received).toEqual([2, 3, 4]);

    sub.unsubscribe();
  });
});
