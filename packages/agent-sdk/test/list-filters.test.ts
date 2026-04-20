/**
 * M6 DB-level tests for list filtering + archive guards + error envelope.
 *
 * No server boot; all assertions are against the db layer + helpers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-list-test-"));
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

async function seedAgent(): Promise<void> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();
  db.prepare(
    `INSERT INTO agents (id, current_version, name, created_at, updated_at)
     VALUES ('agent_lf', 1, 't', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_versions
       (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
     VALUES ('agent_lf', 1, 'm', NULL, '[]', '{}', 0)`,
  ).run();
}

async function seedEnv(id: string): Promise<void> {
  const { getDb } = await import("../src/db/client");
  getDb()
    .prepare(
      `INSERT INTO environments (id, name, config_json, state, created_at)
       VALUES (?, ?, '{}', 'ready', 0)`,
    )
    .run(id, id);
}

interface SeedSessionOpts {
  id: string;
  envId: string;
  status?: "idle" | "running" | "rescheduling" | "terminated";
  createdAt?: number;
}

async function seedSession(opts: SeedSessionOpts): Promise<void> {
  const { getDb } = await import("../src/db/client");
  getDb()
    .prepare(
      `INSERT INTO sessions (
         id, agent_id, agent_version, environment_id, status,
         title, metadata_json, created_at, updated_at
       ) VALUES (?, 'agent_lf', 1, ?, ?, NULL, '{}', ?, ?)`,
    )
    .run(opts.id, opts.envId, opts.status ?? "idle", opts.createdAt ?? 0, opts.createdAt ?? 0);
}

describe("sessions list filters", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("filters by environment_id and status independently and combined", async () => {
    await seedAgent();
    await seedEnv("env_a");
    await seedEnv("env_b");

    await seedSession({ id: "sess_01", envId: "env_a", status: "idle", createdAt: 100 });
    await seedSession({ id: "sess_02", envId: "env_a", status: "running", createdAt: 200 });
    await seedSession({ id: "sess_03", envId: "env_a", status: "terminated", createdAt: 300 });
    await seedSession({ id: "sess_04", envId: "env_b", status: "idle", createdAt: 400 });
    await seedSession({ id: "sess_05", envId: "env_b", status: "idle", createdAt: 500 });

    const { listSessions } = await import("../src/db/sessions");

    // env_a only — 3 sessions
    const inA = listSessions({ environmentId: "env_a", limit: 50 });
    expect(inA.map((s) => s.id).sort()).toEqual(["sess_01", "sess_02", "sess_03"]);

    // env_b only — 2 sessions
    const inB = listSessions({ environmentId: "env_b", limit: 50 });
    expect(inB.map((s) => s.id).sort()).toEqual(["sess_04", "sess_05"]);

    // status=idle only — 3 sessions across both envs
    const idleAll = listSessions({ status: "idle", limit: 50 });
    expect(idleAll.map((s) => s.id).sort()).toEqual(["sess_01", "sess_04", "sess_05"]);

    // Combined: env_a + idle → just sess_01
    const aIdle = listSessions({ environmentId: "env_a", status: "idle", limit: 50 });
    expect(aIdle.map((s) => s.id)).toEqual(["sess_01"]);

    // Nonexistent env_id → empty
    const nobody = listSessions({ environmentId: "env_nope", limit: 50 });
    expect(nobody).toEqual([]);
  });

  it("cursor pagination (DESC) returns the right next_page", async () => {
    await seedAgent();
    await seedEnv("env_p");
    await seedSession({ id: "sess_p01", envId: "env_p", createdAt: 100 });
    await seedSession({ id: "sess_p02", envId: "env_p", createdAt: 200 });
    await seedSession({ id: "sess_p03", envId: "env_p", createdAt: 300 });

    const { listSessions } = await import("../src/db/sessions");

    const page1 = listSessions({ limit: 2, order: "desc" });
    expect(page1.map((s) => s.id)).toEqual(["sess_p03", "sess_p02"]);
    const cursor = page1[page1.length - 1].id;

    const page2 = listSessions({ limit: 2, order: "desc", cursor });
    expect(page2.map((s) => s.id)).toEqual(["sess_p01"]);
  });
});

describe("environment archive guard", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("hasSessionsAttached → true when a non-terminated session exists", async () => {
    await seedAgent();
    await seedEnv("env_g");
    await seedSession({ id: "sess_g1", envId: "env_g", status: "idle" });

    const { hasSessionsAttached } = await import("../src/db/environments");
    expect(hasSessionsAttached("env_g")).toBe(true);
  });

  it("hasSessionsAttached → false when all sessions are terminated", async () => {
    await seedAgent();
    await seedEnv("env_gt");
    await seedSession({ id: "sess_gt1", envId: "env_gt", status: "terminated" });

    const { hasSessionsAttached } = await import("../src/db/environments");
    expect(hasSessionsAttached("env_gt")).toBe(false);
  });

  it("hasSessionsAttached → false when an env has no sessions", async () => {
    await seedAgent();
    await seedEnv("env_empty");

    const { hasSessionsAttached } = await import("../src/db/environments");
    expect(hasSessionsAttached("env_empty")).toBe(false);
  });
});

describe("error envelope", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("toResponse(badRequest(msg)) returns the managed-agents envelope shape", async () => {
    const { toResponse, badRequest } = await import("../src/errors");
    const res = toResponse(badRequest("foo"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(body).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "foo" },
    });
  });

  it("toResponse(notFound(msg)) returns a 404 with not_found_error", async () => {
    const { toResponse, notFound } = await import("../src/errors");
    const res = toResponse(notFound("nope"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_found_error");
  });

  it("toResponse(conflict(msg)) returns a 409 with invalid_request_error", async () => {
    const { toResponse, conflict } = await import("../src/errors");
    const res = toResponse(conflict("bleep"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });
});
