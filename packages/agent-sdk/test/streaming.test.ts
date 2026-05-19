/**
 * Comprehensive SSE streaming pipeline tests.
 *
 * Covers the full event-streaming path: backlog delivery, live EventEmitter
 * fan-out, deduplication, afterSeq filtering, unsubscribe, event type fidelity,
 * error handling, prepareSessionStream auth/header parsing, and the DB-polling
 * path that ensures events written by remote workers (bypassing EventEmitter)
 * are discoverable via listEvents.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure — same pattern as bus.test.ts / api-comprehensive.test.ts
// ---------------------------------------------------------------------------

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-stream-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
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

/** Boot DB + seed a default API key, return the raw key string for auth. */
async function bootDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb(); // triggers migrations
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-stream" });
  return key;
}

/** Seed the minimum rows required for a session: agent + agent_version + environment + session. */
async function seedSession(sessionId: string): Promise<void> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();
  const agentId = `agent_${sessionId}`;
  const envId = `env_${sessionId}`;

  db.prepare(
    `INSERT INTO agents (id, current_version, name, tenant_id, created_at, updated_at)
     VALUES (?, 1, 'test-agent', 'tenant_default', ?, ?)`,
  ).run(agentId, 0, 0);
  db.prepare(
    `INSERT INTO agent_versions (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
     VALUES (?, 1, 'claude-sonnet-4-6', null, '[]', '{}', 0)`,
  ).run(agentId);
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at, updated_at)
     VALUES (?, 'test-env', '{"type":"self_hosted","provider":"docker"}', 'ready', 'tenant_default', 0, 0)`,
  ).run(envId);
  db.prepare(
    `INSERT INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, tenant_id, created_at, updated_at
     ) VALUES (?, ?, 1, ?, 'idle', null, '{}', 'tenant_default', 0, 0)`,
  ).run(sessionId, agentId, envId);
}

beforeEach(() => {
  freshDbEnv();
});

// ---------------------------------------------------------------------------
// Basic streaming
// ---------------------------------------------------------------------------

describe("streaming — basic", () => {
  it("subscribe delivers backlog events from DB", async () => {
    await bootDb();
    const { appendEvent, subscribe } = await import("../src/sessions/bus");
    await seedSession("sess_bl");

    // Append 5 events before subscribing
    for (let i = 1; i <= 5; i++) {
      appendEvent("sess_bl", {
        type: "agent.message",
        payload: { n: i },
        origin: "server",
      });
    }

    const received: number[] = [];
    const sub = subscribe("sess_bl", 0, (evt) => {
      received.push(evt.seq);
    });

    expect(received).toEqual([1, 2, 3, 4, 5]);
    sub.unsubscribe();
  });

  it("subscribe delivers live events from EventEmitter", async () => {
    await bootDb();
    const { appendEvent, subscribe } = await import("../src/sessions/bus");
    await seedSession("sess_live");

    const received: number[] = [];
    const sub = subscribe("sess_live", 0, (evt) => {
      received.push(evt.seq);
    });

    // No backlog — nothing yet
    expect(received).toEqual([]);

    // Append live events after subscribing
    appendEvent("sess_live", {
      type: "agent.message",
      payload: { n: 1 },
      origin: "server",
    });
    appendEvent("sess_live", {
      type: "agent.message",
      payload: { n: 2 },
      origin: "server",
    });

    expect(received).toEqual([1, 2]);
    sub.unsubscribe();
  });

  it("subscribe deduplicates backlog and live events", async () => {
    await bootDb();
    const { appendEvent, subscribe } = await import("../src/sessions/bus");
    await seedSession("sess_dedup");

    // Append an event before subscribing (it goes to DB)
    const row = appendEvent("sess_dedup", {
      type: "agent.message",
      payload: { n: 1 },
      origin: "server",
    });

    const received: number[] = [];
    const sub = subscribe("sess_dedup", 0, (evt) => {
      received.push(evt.seq);
    });

    // Backlog delivers seq 1
    expect(received).toEqual([1]);

    // Now emit the same row again on the EventEmitter — this simulates the
    // race window where an event lands between the DB read and listener attach.
    // The live handler should dedupe by seq.
    const { EventEmitter } = await import("node:events");
    const g = globalThis as typeof globalThis & { __caBusEmitters?: Map<string, InstanceType<typeof EventEmitter>> };
    const em = g.__caBusEmitters?.get("sess_dedup");
    expect(em).toBeDefined();
    em!.emit("event", row);

    // Should still be just [1] — no duplicate
    expect(received).toEqual([1]);
    sub.unsubscribe();
  });

  it("afterSeq filters backlog correctly", async () => {
    await bootDb();
    const { appendEvent, subscribe } = await import("../src/sessions/bus");
    await seedSession("sess_after");

    // Append events with seq 1-5
    for (let i = 1; i <= 5; i++) {
      appendEvent("sess_after", {
        type: "agent.message",
        payload: { n: i },
        origin: "server",
      });
    }

    // Subscribe from seq 3 — should only get seq 4, 5
    const received: number[] = [];
    const sub = subscribe("sess_after", 3, (evt) => {
      received.push(evt.seq);
    });

    expect(received).toEqual([4, 5]);
    sub.unsubscribe();
  });

  it("unsubscribe stops delivery", async () => {
    await bootDb();
    const { appendEvent, subscribe } = await import("../src/sessions/bus");
    await seedSession("sess_unsub");

    const received: number[] = [];
    const sub = subscribe("sess_unsub", 0, (evt) => {
      received.push(evt.seq);
    });

    // Live event — delivered
    appendEvent("sess_unsub", {
      type: "agent.message",
      payload: { n: 1 },
      origin: "server",
    });
    expect(received).toEqual([1]);

    // Unsubscribe
    sub.unsubscribe();

    // Post-unsub event — NOT delivered
    appendEvent("sess_unsub", {
      type: "agent.message",
      payload: { n: 2 },
      origin: "server",
    });
    expect(received).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

describe("streaming — event types", () => {
  it("delivers all event types correctly", async () => {
    await bootDb();
    const { appendEvent, subscribe } = await import("../src/sessions/bus");
    await seedSession("sess_types");

    const received: Array<{ type: string; seq: number }> = [];
    const sub = subscribe("sess_types", 0, (evt) => {
      received.push({ type: evt.type, seq: evt.seq });
    });

    appendEvent("sess_types", {
      type: "user.message",
      payload: { content: [{ type: "text", text: "hello" }] },
      origin: "user",
    });
    appendEvent("sess_types", {
      type: "agent.message",
      payload: { content: [{ type: "text", text: "hi back" }] },
      origin: "server",
    });
    appendEvent("sess_types", {
      type: "agent.tool_use",
      payload: { tool: "bash", input: { command: "ls" } },
      origin: "server",
    });
    appendEvent("sess_types", {
      type: "session.status_idle",
      payload: { stop_reason: { type: "end_turn" } },
      origin: "server",
    });

    expect(received).toEqual([
      { type: "user.message", seq: 1 },
      { type: "agent.message", seq: 2 },
      { type: "agent.tool_use", seq: 3 },
      { type: "session.status_idle", seq: 4 },
    ]);

    // Verify payload content is preserved in the ManagedEvent
    sub.unsubscribe();
  });

  it("delivers session.status_running event", async () => {
    await bootDb();
    const { appendEvent, subscribe } = await import("../src/sessions/bus");
    await seedSession("sess_running");

    const received: Array<{ type: string }> = [];
    const sub = subscribe("sess_running", 0, (evt) => {
      received.push({ type: evt.type });
    });

    appendEvent("sess_running", {
      type: "session.status_running",
      payload: {},
      origin: "server",
    });

    expect(received).toEqual([{ type: "session.status_running" }]);
    sub.unsubscribe();
  });

  it("delivers outcome evaluation events", async () => {
    await bootDb();
    const { appendEvent, subscribe } = await import("../src/sessions/bus");
    await seedSession("sess_outcome");

    const received: Array<{ type: string; seq: number }> = [];
    const sub = subscribe("sess_outcome", 0, (evt) => {
      received.push({ type: evt.type, seq: evt.seq });
    });

    appendEvent("sess_outcome", {
      type: "span.outcome_evaluation_start",
      payload: { evaluation_id: "eval_1" },
      origin: "server",
      spanId: "span_1",
    });
    appendEvent("sess_outcome", {
      type: "span.outcome_evaluation_end",
      payload: { evaluation_id: "eval_1", result: "pass" },
      origin: "server",
      spanId: "span_1",
    });

    expect(received).toEqual([
      { type: "span.outcome_evaluation_start", seq: 1 },
      { type: "span.outcome_evaluation_end", seq: 2 },
    ]);
    sub.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("streaming — error handling", () => {
  it("appendEvent on non-existent session throws", async () => {
    await bootDb();
    const { appendEvent } = await import("../src/sessions/bus");

    expect(() =>
      appendEvent("sess_nonexistent", {
        type: "user.message",
        payload: {},
        origin: "user",
      }),
    ).toThrow(/session not found/);
  });

  it("subscribe with afterSeq beyond existing events still works", async () => {
    await bootDb();
    const { appendEvent, subscribe } = await import("../src/sessions/bus");
    await seedSession("sess_bigseq");

    // Append 2 events
    appendEvent("sess_bigseq", { type: "agent.message", payload: {}, origin: "server" });
    appendEvent("sess_bigseq", { type: "agent.message", payload: {}, origin: "server" });

    // Subscribe from seq 999999 — no backlog, but live events still work
    const received: number[] = [];
    const sub = subscribe("sess_bigseq", 999999, (evt) => {
      received.push(evt.seq);
    });

    // No backlog delivered
    expect(received).toEqual([]);

    // Live events with seq <= 999999 are filtered out by the dedup check
    // (lastDeliveredSeq starts at 999999), so normal seq=3 won't be delivered.
    // This is correct behavior — the client said "I already have everything up to 999999."
    appendEvent("sess_bigseq", { type: "agent.message", payload: {}, origin: "server" });
    // seq=3 is <= 999999, so it should NOT be delivered
    expect(received).toEqual([]);

    sub.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// prepareSessionStream handler
// ---------------------------------------------------------------------------

describe("streaming — prepareSessionStream", () => {
  it("returns afterSeq from last-event-id header", async () => {
    await bootDb();
    await seedSession("sess_hdr");

    // Must init the system (migrations + api_keys already done by bootDb)
    const { ensureInitialized } = await import("../src/init");
    await ensureInitialized();

    const { prepareSessionStream } = await import("../src/handlers/stream");

    const request = new Request(
      `http://localhost/v1/sessions/sess_hdr/events/stream`,
      {
        headers: {
          "x-api-key": "test-api-key-stream",
          "last-event-id": "42",
        },
      },
    );

    const result = await prepareSessionStream(request, "sess_hdr");
    // Should NOT be a Response (error) — should be a PreparedStream
    expect(result).not.toBeInstanceOf(Response);
    const prepared = result as { afterSeq: number; subscribeFn: Function };
    expect(prepared.afterSeq).toBe(42);
  });

  it("returns afterSeq from after_seq query param", async () => {
    await bootDb();
    await seedSession("sess_qp");

    const { ensureInitialized } = await import("../src/init");
    await ensureInitialized();

    const { prepareSessionStream } = await import("../src/handlers/stream");

    const request = new Request(
      `http://localhost/v1/sessions/sess_qp/events/stream?after_seq=17`,
      {
        headers: {
          "x-api-key": "test-api-key-stream",
        },
      },
    );

    const result = await prepareSessionStream(request, "sess_qp");
    expect(result).not.toBeInstanceOf(Response);
    const prepared = result as { afterSeq: number; subscribeFn: Function };
    expect(prepared.afterSeq).toBe(17);
  });

  it("requires auth — no API key returns 401", async () => {
    await bootDb();
    await seedSession("sess_noauth");

    const { ensureInitialized } = await import("../src/init");
    await ensureInitialized();

    const { prepareSessionStream } = await import("../src/handlers/stream");

    const request = new Request(
      `http://localhost/v1/sessions/sess_noauth/events/stream`,
      {
        headers: {
          // No x-api-key header
        },
      },
    );

    const result = await prepareSessionStream(request, "sess_noauth");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DB polling path (the fix for remote worker writes)
// ---------------------------------------------------------------------------

describe("streaming — DB polling", () => {
  it("events written directly to DB (bypassing EventEmitter) are discoverable via listEvents", async () => {
    await bootDb();
    const { appendEvent } = await import("../src/sessions/bus");
    const { listEvents } = await import("../src/db/events");
    const { newId } = await import("../src/util/ids");
    const { getDb } = await import("../src/db/client");
    await seedSession("sess_poll");

    // Append a normal event via the bus (goes to DB + EventEmitter)
    appendEvent("sess_poll", {
      type: "user.message",
      payload: { content: [{ type: "text", text: "hello" }] },
      origin: "user",
    });

    // Verify it's in the DB
    const before = listEvents("sess_poll", { afterSeq: 0, order: "asc", limit: 100 });
    expect(before).toHaveLength(1);
    expect(before[0].seq).toBe(1);

    // Simulate a remote worker writing directly to the DB — this bypasses
    // appendEvent() and hence bypasses the EventEmitter. This is the exact
    // scenario that broke streaming before the DB-polling fix.
    const db = getDb();
    const evtId = newId("evt");
    const now = Date.now();
    db.prepare(
      `INSERT INTO events (
         id, session_id, seq, type, payload_json,
         processed_at, received_at, origin
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(evtId, "sess_poll", 2, "agent.message", JSON.stringify({ content: [{ type: "text", text: "from worker" }] }), now, now, "server");

    // Update last_seq on the session to match
    db.prepare(`UPDATE sessions SET last_seq = 2 WHERE id = ?`).run("sess_poll");

    // The event should be discoverable via listEvents (the DB polling path)
    const after = listEvents("sess_poll", { afterSeq: 1, order: "asc", limit: 100 });
    expect(after).toHaveLength(1);
    expect(after[0].seq).toBe(2);
    expect(after[0].type).toBe("agent.message");
    expect(after[0].id).toBe(evtId);

    // Parse the payload to verify content
    const payload = JSON.parse(after[0].payload_json) as { content: Array<{ type: string; text: string }> };
    expect(payload.content[0].text).toBe("from worker");

    // Also verify full listing from seq 0 returns both events
    const all = listEvents("sess_poll", { afterSeq: 0, order: "asc", limit: 100 });
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.seq)).toEqual([1, 2]);
  });
});
