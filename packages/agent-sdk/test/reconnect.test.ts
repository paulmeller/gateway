/**
 * M5 reconnect test: Last-Event-ID replay via bus.subscribe with a non-zero
 * fromSeq, mid-stream appends, and dedup.
 *
 * This validates the stream route's reconnect pattern:
 *   - Client disconnects at seq N, reconnects with `Last-Event-ID: N`
 *   - Server calls subscribe(sessionId, fromSeq=N) → backlog from DB + live tail
 *   - Gap-free delivery and no duplicates, even if live events race the attach
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-rec-test-"));
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

async function seedSession(id: string): Promise<void> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();
  db.prepare(
    `INSERT INTO agents (id, current_version, name, created_at, updated_at)
     VALUES ('agent_r', 1, 't', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_versions
       (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
     VALUES ('agent_r', 1, 'm', NULL, '[]', '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, created_at)
     VALUES ('env_r', 't', '{}', 'ready', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, created_at, updated_at
     ) VALUES (?, 'agent_r', 1, 'env_r', 'idle', NULL, '{}', 0, 0)`,
  ).run(id);
}

describe("reconnect", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("replays backlog from fromSeq and tails live events without dupes", async () => {
    await seedSession("sess_rec");
    const { appendEvent, subscribe } = await import("../src/sessions/bus");

    // Seed 5 events before subscribing
    for (let i = 0; i < 5; i++) {
      appendEvent("sess_rec", {
        type: "agent.message",
        payload: { n: i + 1 },
        origin: "server",
      });
    }

    // Subscribe with fromSeq=3 — should receive seq 4 and 5 from backlog
    const received: Array<{ seq: number; type: string }> = [];
    const sub = subscribe("sess_rec", 3, (evt) => {
      received.push({ seq: evt.seq, type: evt.type });
    });

    expect(received.map((e) => e.seq)).toEqual([4, 5]);

    // Fire two more events — should arrive live via the emitter
    appendEvent("sess_rec", { type: "agent.message", payload: { n: 6 }, origin: "server" });
    appendEvent("sess_rec", { type: "agent.message", payload: { n: 7 }, origin: "server" });

    expect(received.map((e) => e.seq)).toEqual([4, 5, 6, 7]);

    // Assert no duplicates and monotonic
    const seqs = received.map((e) => e.seq);
    const unique = new Set(seqs);
    expect(unique.size).toBe(seqs.length);

    sub.unsubscribe();
  });

  it("dedup guard prevents replay from backfill + emitter overlap", async () => {
    await seedSession("sess_rec2");
    const { appendEvent, subscribe } = await import("../src/sessions/bus");

    // Seed 3 events
    for (let i = 0; i < 3; i++) {
      appendEvent("sess_rec2", {
        type: "agent.message",
        payload: { n: i + 1 },
        origin: "server",
      });
    }

    const received: number[] = [];
    const sub = subscribe("sess_rec2", 0, (evt) => {
      received.push(evt.seq);
    });

    // Backlog delivered seq 1,2,3
    expect(received).toEqual([1, 2, 3]);

    // Live event
    appendEvent("sess_rec2", { type: "agent.message", payload: { n: 4 }, origin: "server" });
    expect(received).toEqual([1, 2, 3, 4]);

    // No duplicates
    expect(new Set(received).size).toBe(received.length);
    sub.unsubscribe();
  });
});
