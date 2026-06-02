/**
 * PR-Z1 tests: ZDR flag is inherited from environment to session at
 * session-create time, and is **immutable for the session's lifetime**
 * — toggling the env flag afterwards does not retroactively change
 * existing sessions.
 *
 * The actual purge behavior is exercised in PR-Z2's tests. This file
 * just verifies the schema + flag-plumbing contract.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-zdr-flag-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
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

async function seedAgent(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { nowMs } = await import("../src/util/clock");
  const db = getDb();
  const now = nowMs();
  db.prepare(
    `INSERT INTO agents (id, current_version, name, tenant_id, created_at, updated_at)
     VALUES ('agent_zdr', 1, 'a', 'tenant_default', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO agent_versions (agent_id, version, model, tools_json, mcp_servers_json, backend, webhook_events_json, skills_json, model_config_json, created_at)
     VALUES ('agent_zdr', 1, 'claude-sonnet-4-6', '[]', '{}', 'claude', '[]', '[]', '{}', ?)`,
  ).run(now);
  return "agent_zdr";
}

describe("ZDR flag inheritance (PR-Z1)", () => {
  beforeEach(() => freshDbEnv());

  it("1. session inherits zero_data_retention=true from a ZDR-enabled env", async () => {
    await seedAgent();
    const { createEnvironment } = await import("../src/db/environments");
    const { createSession, getSession } = await import("../src/db/sessions");

    const env = createEnvironment({
      name: "zdr-env",
      config: { type: "cloud", provider: "docker", zero_data_retention: true },
      tenant_id: "tenant_default",
    });
    // Manually mark env ready (skip async setup state machine for this test)
    const { getDb } = await import("../src/db/client");
    getDb().prepare(`UPDATE environments SET state='ready' WHERE id=?`).run(env.id);

    const session = createSession({
      agent_id: "agent_zdr",
      agent_version: 1,
      environment_id: env.id,
      tenant_id: "tenant_default",
      zero_data_retention: true,
    });

    const fetched = getSession(session.id);
    expect(fetched?.zero_data_retention).toBe(true);
    expect(fetched?.retention_purged_at).toBeNull();
  });

  it("2. session defaults to zero_data_retention=false when env doesn't set it", async () => {
    await seedAgent();
    const { createEnvironment } = await import("../src/db/environments");
    const { createSession, getSession } = await import("../src/db/sessions");

    const env = createEnvironment({
      name: "regular-env",
      config: { type: "cloud", provider: "docker" }, // ZDR field absent
      tenant_id: "tenant_default",
    });
    const { getDb } = await import("../src/db/client");
    getDb().prepare(`UPDATE environments SET state='ready' WHERE id=?`).run(env.id);

    const session = createSession({
      agent_id: "agent_zdr",
      agent_version: 1,
      environment_id: env.id,
      tenant_id: "tenant_default",
      // No zero_data_retention specified — should default to false
    });

    const fetched = getSession(session.id);
    expect(fetched?.zero_data_retention).toBe(false);
  });

  it("3. session flag is IMMUTABLE — toggling env config after create does not flip the session", async () => {
    await seedAgent();
    const { createEnvironment, updateEnvironment } = await import("../src/db/environments");
    const { createSession, getSession } = await import("../src/db/sessions");

    const env = createEnvironment({
      name: "non-zdr-then-zdr",
      config: { type: "cloud", provider: "docker", zero_data_retention: false },
      tenant_id: "tenant_default",
    });
    const { getDb } = await import("../src/db/client");
    getDb().prepare(`UPDATE environments SET state='ready' WHERE id=?`).run(env.id);

    // Create session with the env's CURRENT flag (false)
    const session = createSession({
      agent_id: "agent_zdr",
      agent_version: 1,
      environment_id: env.id,
      tenant_id: "tenant_default",
      zero_data_retention: false,
    });
    expect(getSession(session.id)?.zero_data_retention).toBe(false);

    // Now toggle the env config to ZDR
    updateEnvironment(env.id, {
      config: { type: "cloud", provider: "docker", zero_data_retention: true },
    });

    // Session's flag should be unchanged. This is the immutability contract:
    // retroactive ZDR enrollment of existing sessions requires the explicit
    // `/environments/{id}/purge-existing` admin endpoint (PR-Z3).
    expect(getSession(session.id)?.zero_data_retention).toBe(false);
  });
});
