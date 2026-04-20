/**
 * M(opencode-adapter) fake-exec round-trip test.
 *
 * Drives the opencode backend through the driver with scripted NDJSON
 * fixtures. No real sprites.dev or opencode — vi.mock intercepts exec and
 * lifecycle.
 *
 * Covers:
 *   1. Two-turn flow: turn 1 sends a text prompt, turn 2 resumes via
 *      `--session <sessionID>`. Asserts argv, stdin shape, agent.message
 *      emission, stop_reason end_turn, claude_session_id persistence.
 *   2. Rejection of user.custom_tool_result for opencode agents (opencode
 *      has no stream-json re-entry — the buildTurn throw should surface
 *      as session.error + session.status_idle{error}).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Hoisted mocks — must be at module top.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-oc-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.SPRITE_TOKEN = "test-token";
  // Opencode requires ANTHROPIC_API_KEY (not CLAUDE_CODE_OAUTH_TOKEN).
  // The fake-exec doesn't transmit it, but validateRuntime gates on it.
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-test";
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

function readFixture(name: string): string[] {
  const file = path.join(__dirname, "fixtures/opencode-stream", name);
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function seedAgentEnvSession(): Promise<{ sessionId: string }> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();

  db.prepare(
    `INSERT INTO agents (id, current_version, name, created_at, updated_at)
     VALUES ('agent_oc', 1, 't', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_versions
       (agent_id, version, model, system, tools_json, mcp_servers_json, backend, created_at)
     VALUES ('agent_oc', 1, 'anthropic/claude-sonnet-4-6', NULL, '[]', '{}', 'opencode', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, created_at)
     VALUES ('env_oc', 't', '{}', 'ready', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, created_at, updated_at, sprite_name
     ) VALUES ('sess_oc', 'agent_oc', 1, 'env_oc', 'idle', NULL, '{}', 0, 0, 'ca-sess-fake')`,
  ).run();

  return { sessionId: "sess_oc" };
}

describe("e2e opencode round-trip (fake exec)", () => {
  beforeEach(() => {
    freshDbEnv();
    vi.clearAllMocks();
  });

  it("runs two turns, resumes via --session, emits agent.message + end_turn", async () => {
    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    const { sessionId } = await seedAgentEnvSession();

    // --- Turn 1 ---
    let turn1Stdin = "";
    fake.enqueueTurn({
      ndjson: readFixture("turn1.ndjson"),
      onStdin: (body) => {
        turn1Stdin = body;
      },
    });

    const { runTurn } = await import("../src/sessions/driver");
    await runTurn(sessionId, [
      { kind: "text", eventId: "evt_t1", text: "hello from curl" },
    ]);

    const { getDb } = await import("../src/db/client");
    const db = getDb();

    const events1 = db
      .prepare(
        `SELECT type, payload_json, seq FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as { type: string; payload_json: string; seq: number }[];

    const types1 = events1.map((e) => e.type);
    expect(types1).toContain("session.status_running");
    expect(types1).toContain("agent.message");
    expect(types1).toContain("span.model_request_end");
    expect(types1).toContain("session.status_idle");

    const idleEvent1 = events1.filter((e) => e.type === "session.status_idle").at(-1);
    const idlePayload1 = JSON.parse(idleEvent1!.payload_json) as { stop_reason: { type: string } };
    expect(idlePayload1.stop_reason).toEqual({ type: "end_turn" });

    const agentMessage = events1.find((e) => e.type === "agent.message");
    const agentPayload = JSON.parse(agentMessage!.payload_json) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(agentPayload.content[0].text).toBe("Hello from opencode.");

    // Turn 1 stdin should contain env block + blank line + wrapped prompt.
    // opencode agents with no system prompt pass the prompt verbatim.
    expect(turn1Stdin).toContain("ANTHROPIC_API_KEY=sk-ant-fake-for-test");
    expect(turn1Stdin).toContain("hello from curl");

    // Backend session id captured from turn 1 fixture
    const row1 = db
      .prepare(
        `SELECT claude_session_id FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as { claude_session_id: string } | undefined;
    expect(row1?.claude_session_id).toBe("ses_fixture_01");

    // --- Turn 2: resume ---
    let turn2Stdin = "";
    let turn2Argv: string[] | undefined;
    fake.enqueueTurn({
      ndjson: readFixture("turn2.ndjson"),
      onStdin: (body) => {
        turn2Stdin = body;
      },
      onArgv: (argv: string[]) => {
        turn2Argv = argv;
      },
    });

    await runTurn(sessionId, [
      { kind: "text", eventId: "evt_t2", text: "what did I just say?" },
    ]);

    // Turn 2 argv must contain --session with the captured sessionID
    expect(turn2Argv).toBeDefined();
    const sessionFlagIdx = turn2Argv!.indexOf("--session");
    expect(sessionFlagIdx).toBeGreaterThanOrEqual(0);
    expect(turn2Argv![sessionFlagIdx + 1]).toBe("ses_fixture_01");

    // Turn 2 stdin still contains the new user prompt
    expect(turn2Stdin).toContain("what did I just say?");

    // Event log has two agent.messages now
    const events2 = db
      .prepare(
        `SELECT type, payload_json FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as { type: string; payload_json: string }[];
    const allMessages = events2
      .filter((e) => e.type === "agent.message")
      .map((e) => JSON.parse(e.payload_json) as { content: Array<{ text: string }> });
    expect(allMessages.length).toBe(2);
    expect(allMessages[1].content[0].text).toBe("You said hello.");
  });

  it("rejects user.custom_tool_result for opencode agents with a clear error", async () => {
    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    const { sessionId } = await seedAgentEnvSession();

    const { runTurn } = await import("../src/sessions/driver");
    await runTurn(sessionId, [
      {
        kind: "tool_result",
        eventId: "evt_cr",
        custom_tool_use_id: "toolu_fake",
        content: [{ type: "text", text: "fake reply" }],
      },
    ]);

    const { getDb } = await import("../src/db/client");
    const db = getDb();
    const events = db
      .prepare(
        `SELECT type, payload_json FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as { type: string; payload_json: string }[];

    const errorEvent = events.find((e) => e.type === "session.error");
    expect(errorEvent).toBeDefined();
    const errPayload = JSON.parse(errorEvent!.payload_json) as {
      error: { type: string; message: string };
    };
    expect(errPayload.error.type).toBe("invalid_request_error");
    expect(errPayload.error.message).toContain("opencode");
    expect(errPayload.error.message).toContain("custom_tool_result");

    const finalIdle = events.filter((e) => e.type === "session.status_idle").at(-1);
    const idlePayload = JSON.parse(finalIdle!.payload_json) as { stop_reason: { type: string } };
    expect(idlePayload.stop_reason).toEqual({ type: "error" });
  });
});
