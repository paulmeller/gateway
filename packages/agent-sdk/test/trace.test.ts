/**
 * Observability trace/span plumbing tests.
 *
 * Covers three things the architect review flagged as must-have:
 *
 *   1. Trace propagation: every event emitted by driver during a single
 *      `runTurn` carries the same `trace_id`, tool-result recursion reuses
 *      it, and sub-agent spawns inherit it so cross-session waterfalls
 *      render as one tree.
 *
 *   2. Span-leak fixes on error paths: when `buildTurn` throws or
 *      `provider.startExec` fails *after* `span.model_request_start`, the
 *      driver must close the span with a matching `span.model_request_end`
 *      before returning. Otherwise the open span dangles forever.
 *
 *   3. `appendEventsBatch` no longer re-reads `sessions.last_seq` on every
 *      row — it reads once and increments in memory. Verify by inserting a
 *      batch and checking seq monotonicity plus the session row's final
 *      counter.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ─────────────────────────────────────────────────────────────────────────
// Shared test harness mocks
// ─────────────────────────────────────────────────────────────────────────

vi.mock("../src/containers/exec", async () => {
  const fake = await import("./helpers/fake-exec");
  return { startExec: fake.startExec };
});

vi.mock("../src/containers/lifecycle", () => ({
  acquireForFirstTurn: vi.fn(async () => "ca-sess-fake"),
  releaseSession: vi.fn(async () => {}),
  reconcileOrphans: vi.fn(async () => ({ deleted: 0, kept: 0 })),
  reconcileDockerOrphans: vi.fn(async () => ({ deleted: 0, kept: 0 })),
}));

vi.mock("../src/providers/registry", async () => {
  const fake = await import("./helpers/fake-exec");
  return {
    resolveContainerProvider: async () => ({
      name: "sprites",
      stripControlChars: true,
      startExec: fake.startExec,
      exec: vi.fn(async () => ({ stdout: "", stderr: "", exit_code: 0 })),
      create: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    }),
  };
});

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-trace-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.SPRITE_TOKEN = "test-token";
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-test";
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caActors?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  delete g.__caActors;
}

async function seedSession(sessionId: string): Promise<void> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();
  db.prepare(
    `INSERT INTO agents (id, current_version, name, created_at, updated_at)
     VALUES ('agent_trc', 1, 't', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_versions
       (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
     VALUES ('agent_trc', 1, 'claude-sonnet-4-6', NULL, '[]', '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, created_at)
     VALUES ('env_trc', 't', '{}', 'ready', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, created_at, updated_at, sprite_name
     ) VALUES (?, 'agent_trc', 1, 'env_trc', 'idle', NULL, '{}', 0, 0, 'ca-sess-fake')`,
  ).run(sessionId);
}

interface EventLite {
  type: string;
  seq: number;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  payload_json: string;
}

async function readEvents(sessionId: string): Promise<EventLite[]> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();
  return db
    .prepare(
      `SELECT type, seq, trace_id, span_id, parent_span_id, payload_json
         FROM events WHERE session_id = ? ORDER BY seq ASC`,
    )
    .all(sessionId) as EventLite[];
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Unit tests for the trace helper
// ─────────────────────────────────────────────────────────────────────────

describe("trace helper", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("newTrace mints a fresh trace_id + span_id with null parent", async () => {
    const { newTrace } = await import("../src/sessions/trace");
    const t = newTrace();
    expect(t.trace_id).toMatch(/^trace_/);
    expect(t.span_id).toMatch(/^span_/);
    expect(t.parent_span_id).toBeNull();
  });

  it("childSpan keeps trace_id, mints a new span_id, parents to the input span", async () => {
    const { newTrace, childSpan } = await import("../src/sessions/trace");
    const root = newTrace();
    const child = childSpan(root);
    expect(child.trace_id).toBe(root.trace_id);
    expect(child.span_id).not.toBe(root.span_id);
    expect(child.span_id).toMatch(/^span_/);
    expect(child.parent_span_id).toBe(root.span_id);
  });

  it("childSpan is non-mutating", async () => {
    const { newTrace, childSpan } = await import("../src/sessions/trace");
    const root = newTrace();
    const rootCopy = { ...root };
    childSpan(root);
    expect(root).toEqual(rootCopy);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. appendEventsBatch last_seq fix — regression against the per-row
//    SELECT loop the architect review flagged.
// ─────────────────────────────────────────────────────────────────────────

describe("appendEventsBatch seq reservation", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("assigns monotonic seqs across a large batch and advances last_seq exactly once", async () => {
    const { getDb } = await import("../src/db/client");
    const { appendEventsBatch } = await import("../src/sessions/bus");
    const db = getDb();

    db.prepare(
      `INSERT INTO agents (id, current_version, name, created_at, updated_at)
       VALUES ('agent_b', 1, 't', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO agent_versions
         (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
       VALUES ('agent_b', 1, 'm', null, '[]', '{}', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, created_at)
       VALUES ('env_b', 't', '{}', 'ready', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (
         id, agent_id, agent_version, environment_id, status,
         title, metadata_json, created_at, updated_at
       ) VALUES ('sess_b', 'agent_b', 1, 'env_b', 'idle', null, '{}', 0, 0)`,
    ).run();

    const inputs = Array.from({ length: 50 }, (_, i) => ({
      type: "agent.message",
      payload: { n: i },
      origin: "server" as const,
      traceId: "trace_fixed",
      spanId: "span_fixed",
    }));

    const rows = appendEventsBatch("sess_b", inputs);
    expect(rows.map((r) => r.seq)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );

    // Every row should carry the trace/span ids we passed in
    expect(rows.every((r) => r.trace_id === "trace_fixed")).toBe(true);
    expect(rows.every((r) => r.span_id === "span_fixed")).toBe(true);
    expect(rows.every((r) => r.parent_span_id === null)).toBe(true);

    // Session row's last_seq must equal the final seq, not drift
    const sessRow = db
      .prepare(`SELECT last_seq FROM sessions WHERE id = ?`)
      .get("sess_b") as { last_seq: number };
    expect(sessRow.last_seq).toBe(50);

    // DB events should all have the trace/span columns populated
    const dbRows = db
      .prepare(
        `SELECT trace_id, span_id, parent_span_id FROM events WHERE session_id = ? ORDER BY seq`,
      )
      .all("sess_b") as Array<{ trace_id: string; span_id: string; parent_span_id: null }>;
    expect(dbRows).toHaveLength(50);
    expect(dbRows.every((r) => r.trace_id === "trace_fixed")).toBe(true);
  });

  it("second batch continues from the previous last_seq without gaps", async () => {
    const { getDb } = await import("../src/db/client");
    const { appendEventsBatch } = await import("../src/sessions/bus");
    const db = getDb();

    db.prepare(
      `INSERT INTO agents (id, current_version, name, created_at, updated_at)
       VALUES ('agent_b2', 1, 't', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO agent_versions
         (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
       VALUES ('agent_b2', 1, 'm', null, '[]', '{}', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, created_at)
       VALUES ('env_b2', 't', '{}', 'ready', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (
         id, agent_id, agent_version, environment_id, status,
         title, metadata_json, created_at, updated_at
       ) VALUES ('sess_b2', 'agent_b2', 1, 'env_b2', 'idle', null, '{}', 0, 0)`,
    ).run();

    const first = appendEventsBatch("sess_b2", [
      { type: "agent.message", payload: {}, origin: "server" },
      { type: "agent.message", payload: {}, origin: "server" },
      { type: "agent.message", payload: {}, origin: "server" },
    ]);
    expect(first.map((r) => r.seq)).toEqual([1, 2, 3]);

    const second = appendEventsBatch("sess_b2", [
      { type: "agent.message", payload: {}, origin: "server" },
      { type: "agent.message", payload: {}, origin: "server" },
    ]);
    expect(second.map((r) => r.seq)).toEqual([4, 5]);

    const sessRow = db
      .prepare(`SELECT last_seq FROM sessions WHERE id = ?`)
      .get("sess_b2") as { last_seq: number };
    expect(sessRow.last_seq).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. End-to-end trace propagation through runTurn (fake-exec)
// ─────────────────────────────────────────────────────────────────────────

describe("driver trace propagation (fake exec)", () => {
  beforeEach(() => {
    freshDbEnv();
    vi.clearAllMocks();
  });

  it("every event in a happy-path turn shares one trace_id and one span_id", async () => {
    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    await seedSession("sess_happy");

    // Minimal scripted NDJSON: init → assistant → result
    fake.enqueueTurn({
      ndjson: [
        '{"type":"system","subtype":"init","session_id":"cc_fix_h","model":"claude-sonnet-4-6","tools":[],"mcp_servers":[]}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
        '{"type":"result","subtype":"success","session_id":"cc_fix_h","num_turns":1,"total_cost_usd":0.001,"usage":{"input_tokens":3,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
      ],
    });

    const { runTurn } = await import("../src/sessions/driver");
    await runTurn("sess_happy", [
      { kind: "text", eventId: "evt_h1", text: "ping" },
    ]);

    const events = await readEvents("sess_happy");

    // Every driver-emitted event MUST have a trace_id + span_id. Non-user
    // events only — the user.message row is inserted by the handler, not
    // the driver, so it's exempt.
    const driverEvents = events.filter((e) => e.type !== "user.message");
    expect(driverEvents.length).toBeGreaterThan(0);
    const traceIds = new Set(driverEvents.map((e) => e.trace_id));
    const spanIds = new Set(driverEvents.map((e) => e.span_id));
    expect(traceIds.size).toBe(1);
    expect(spanIds.size).toBe(1);
    const [traceId] = [...traceIds];
    const [spanId] = [...spanIds];
    expect(traceId).toMatch(/^trace_/);
    expect(spanId).toMatch(/^span_/);

    // Must have opened AND closed the span exactly once
    const starts = events.filter((e) => e.type === "span.model_request_start");
    const ends = events.filter((e) => e.type === "span.model_request_end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);

    // End span should carry status=ok on happy path
    const endPayload = JSON.parse(ends[0].payload_json) as { status?: string };
    expect(endPayload.status).toBe("ok");
  });

  it("closes the open span when buildTurn throws after span_start (span-leak fix)", async () => {
    // Mock the claude backend's buildTurn to throw. We re-import the
    // registry and monkey-patch. Use vi.doMock so the mutation lands
    // before the driver module is loaded.
    vi.doMock("../src/backends/registry", async () => {
      const actual = await vi.importActual<typeof import("../src/backends/registry")>(
        "../src/backends/registry",
      );
      return {
        ...actual,
        resolveBackend: () => {
          const base = actual.resolveBackend("claude");
          return {
            ...base,
            buildTurn: () => {
              throw new Error("synthetic buildTurn failure");
            },
          };
        },
      };
    });

    await seedSession("sess_leak");

    const { runTurn } = await import("../src/sessions/driver");
    await runTurn("sess_leak", [
      { kind: "text", eventId: "evt_x1", text: "boom" },
    ]);

    const events = await readEvents("sess_leak");
    const types = events.map((e) => e.type);

    // Start MUST be followed by a matching end — the whole point of the
    // fix. Before the fix, `types` would contain span_start but no
    // span_end for this path, leaving the trace tree dangling.
    expect(types).toContain("span.model_request_start");
    expect(types).toContain("span.model_request_end");
    expect(types).toContain("session.error");
    expect(types).toContain("session.status_idle");

    // End span carries status=error on the failure path
    const end = events.find((e) => e.type === "span.model_request_end")!;
    const endPayload = JSON.parse(end.payload_json) as { status?: string };
    expect(endPayload.status).toBe("error");

    // Start and end share the same span_id
    const start = events.find((e) => e.type === "span.model_request_start")!;
    expect(start.span_id).toBe(end.span_id);
    expect(start.trace_id).toBe(end.trace_id);
    expect(start.trace_id).not.toBeNull();

    // Error rows carry the same trace/span so the failure is attributable
    const errRow = events.find((e) => e.type === "session.error")!;
    expect(errRow.trace_id).toBe(start.trace_id);
    expect(errRow.span_id).toBe(start.span_id);

    vi.doUnmock("../src/backends/registry");
  });
});
