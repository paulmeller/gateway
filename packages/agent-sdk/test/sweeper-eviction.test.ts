/**
 * M5 sweeper eviction tests — no real sprites.
 *
 * Mocks containers/lifecycle (formerly sprite/lifecycle) so releaseSession / reconcileOrphans are
 * no-op spies. Seeds session rows directly and exercises the sweep loop.
 *
 * Covered:
 *   1. Happy path: idle+expired session is evicted.
 *   2. Zero-turn session (idle_since IS NULL): aged from created_at via COALESCE.
 *   3. Fresh idle (not expired): no-op.
 *   4. status='running': no-op (status guard).
 *   5. inFlightRuns guard: even if DB says idle, runtime map vetoes eviction.
 *   6. Re-entrancy: second runSweep during an active sweep no-ops.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const releaseSessionMock = vi.fn(async () => {});
const reconcileOrphansMock = vi.fn(async () => ({ deleted: 0, kept: 0 }));
const reconcileDockerOrphansMock = vi.fn(async () => ({ deleted: 0, kept: 0 }));

// Hoisted mock — must be at module top.
vi.mock("../src/containers/lifecycle", () => ({
  releaseSession: releaseSessionMock,
  reconcileOrphans: reconcileOrphansMock,
  reconcileDockerOrphans: reconcileDockerOrphansMock,
  acquireForFirstTurn: vi.fn(async () => "ca-sess-fake"),
}));

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-sweep-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.SPRITE_TOKEN = "test-token";
  process.env.SESSION_MAX_AGE_MS = "60000"; // 60s for the tests
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

async function seedAgentEnv(): Promise<void> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();
  db.prepare(
    `INSERT INTO agents (id, current_version, name, created_at, updated_at)
     VALUES ('agent_s', 1, 't', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_versions
       (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
     VALUES ('agent_s', 1, 'm', NULL, '[]', '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, created_at)
     VALUES ('env_s', 't', '{}', 'ready', 0)`,
  ).run();
}

interface SeedSessionOpts {
  id: string;
  status?: "idle" | "running" | "terminated";
  idleSince?: number | null;
  createdAt?: number;
  spriteName?: string | null;
  archivedAt?: number | null;
}

async function seedSession(opts: SeedSessionOpts): Promise<void> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, created_at, updated_at,
       sprite_name, idle_since, archived_at
     ) VALUES (?, 'agent_s', 1, 'env_s', ?, NULL, '{}', ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.status ?? "idle",
    opts.createdAt ?? Date.now(),
    opts.createdAt ?? Date.now(),
    opts.spriteName ?? null,
    opts.idleSince ?? null,
    opts.archivedAt ?? null,
  );
}

describe("sweeper eviction", () => {
  beforeEach(() => {
    freshDbEnv();
    releaseSessionMock.mockClear();
    reconcileOrphansMock.mockClear();
  });

  it("evicts an idle session whose idle_since is past the TTL", async () => {
    await seedAgentEnv();
    const now = Date.now();
    await seedSession({
      id: "sess_evict_1",
      status: "idle",
      idleSince: now - 120_000, // way past 60s TTL
      createdAt: now - 200_000,
      spriteName: "ca-sess-foo",
    });

    const { runSweep, __resetSweeperState } = await import("../src/sessions/sweeper");
    __resetSweeperState();
    await runSweep();

    expect(releaseSessionMock).toHaveBeenCalledWith("sess_evict_1");

    const { getDb } = await import("../src/db/client");
    const db = getDb();
    const row = db
      .prepare(
        `SELECT status, stop_reason, archived_at FROM sessions WHERE id = ?`,
      )
      .get("sess_evict_1") as { status: string; stop_reason: string; archived_at: number | null } | undefined;
    expect(row?.status).toBe("terminated");
    expect(row?.stop_reason).toBe("idle_ttl");
    expect(row?.archived_at).not.toBeNull();

    const events = db
      .prepare(
        `SELECT type, payload_json FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all("sess_evict_1") as { type: string; payload_json: string }[];
    const termEvent = events.find((e) => e.type === "session.status_terminated");
    expect(termEvent).toBeDefined();
    const payload = JSON.parse(termEvent!.payload_json) as { reason: string };
    expect(payload.reason).toBe("idle_ttl");
  });

  it("evicts a zero-turn session via COALESCE(idle_since, created_at)", async () => {
    await seedAgentEnv();
    const now = Date.now();
    await seedSession({
      id: "sess_zero",
      status: "idle",
      idleSince: null, // never ran a turn
      createdAt: now - 120_000, // created 2 minutes ago, TTL=60s
      spriteName: null,
    });

    const { runSweep, __resetSweeperState } = await import("../src/sessions/sweeper");
    __resetSweeperState();
    await runSweep();

    const { getDb } = await import("../src/db/client");
    const row = getDb()
      .prepare(
        `SELECT status FROM sessions WHERE id = ?`,
      )
      .get("sess_zero") as { status: string } | undefined;
    expect(row?.status).toBe("terminated");
  });

  it("leaves a freshly-idle session alone", async () => {
    await seedAgentEnv();
    const now = Date.now();
    await seedSession({
      id: "sess_fresh",
      status: "idle",
      idleSince: now - 1000, // fresh
      createdAt: now - 5000,
      spriteName: "ca-sess-fresh",
    });

    const { runSweep, __resetSweeperState } = await import("../src/sessions/sweeper");
    __resetSweeperState();
    await runSweep();

    expect(releaseSessionMock).not.toHaveBeenCalled();
    const { getDb } = await import("../src/db/client");
    const row = getDb()
      .prepare(`SELECT status FROM sessions WHERE id = ?`)
      .get("sess_fresh") as { status: string } | undefined;
    expect(row?.status).toBe("idle");
  });

  it("leaves a running session alone even if idle_since is expired", async () => {
    await seedAgentEnv();
    const now = Date.now();
    await seedSession({
      id: "sess_running",
      status: "running",
      idleSince: now - 120_000, // ancient
      createdAt: now - 200_000,
      spriteName: "ca-sess-running",
    });

    const { runSweep, __resetSweeperState } = await import("../src/sessions/sweeper");
    __resetSweeperState();
    await runSweep();

    expect(releaseSessionMock).not.toHaveBeenCalled();
    const { getDb } = await import("../src/db/client");
    const row = getDb()
      .prepare(`SELECT status FROM sessions WHERE id = ?`)
      .get("sess_running") as { status: string } | undefined;
    expect(row?.status).toBe("running");
  });

  it("respects the inFlightRuns guard even if DB status lags", async () => {
    await seedAgentEnv();
    const now = Date.now();
    await seedSession({
      id: "sess_inflight",
      status: "idle", // DB says idle...
      idleSince: now - 120_000,
      createdAt: now - 200_000,
      spriteName: "ca-sess-inflight",
    });

    // ...but inFlightRuns says a turn is in progress (simulates the
    // millisecond window between POST /events releasing the actor and
    // runTurn flipping status to "running").
    const { getRuntime } = await import("../src/state");
    getRuntime().inFlightRuns.set("sess_inflight", {
      sessionId: "sess_inflight",
      controller: new AbortController(),
      startedAt: Date.now(),
    });

    const { runSweep, __resetSweeperState } = await import("../src/sessions/sweeper");
    __resetSweeperState();
    await runSweep();

    expect(releaseSessionMock).not.toHaveBeenCalled();
    const { getDb } = await import("../src/db/client");
    const row = getDb()
      .prepare(`SELECT status FROM sessions WHERE id = ?`)
      .get("sess_inflight") as { status: string } | undefined;
    expect(row?.status).toBe("idle");

    // Clear the guard and re-sweep — now it should evict.
    getRuntime().inFlightRuns.delete("sess_inflight");
    await runSweep();
    expect(releaseSessionMock).toHaveBeenCalledWith("sess_inflight");
  });

  it("re-entrancy guard: concurrent runSweep calls do not stack", async () => {
    await seedAgentEnv();
    const now = Date.now();
    await seedSession({
      id: "sess_reentrancy",
      status: "idle",
      idleSince: now - 120_000,
      createdAt: now - 200_000,
      spriteName: "ca-sess-reentrant",
    });

    const { runSweep, __resetSweeperState } = await import("../src/sessions/sweeper");
    __resetSweeperState();

    // Fire two sweeps without awaiting the first
    const p1 = runSweep();
    const p2 = runSweep();
    await Promise.all([p1, p2]);

    // The first sweep should have run exactly one eviction; the second
    // should have no-op'd because the `sweeping` flag was set.
    expect(releaseSessionMock).toHaveBeenCalledTimes(1);
  });
});
