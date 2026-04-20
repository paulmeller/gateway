/**
 * Codex backend fake-exec e2e test.
 *
 * Drives the codex backend through the driver with scripted NDJSON fixtures.
 * Covers: simple text turn, command_execution with tool_use+tool_result pair,
 * user.custom_tool_result rejection, and turn.completed usage propagation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-cx-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.SPRITE_TOKEN = "test-token";
  process.env.OPENAI_API_KEY = "sk-fake-for-test";
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
  const file = path.join(__dirname, "fixtures/codex-stream", name);
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
     VALUES ('agent_cx', 1, 't', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_versions
       (agent_id, version, model, system, tools_json, mcp_servers_json, backend, created_at)
     VALUES ('agent_cx', 1, 'gpt-5.4-mini', NULL, '[]', '{}', 'codex', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, created_at)
     VALUES ('env_cx', 't', '{}', 'ready', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, created_at, updated_at, sprite_name
     ) VALUES ('sess_cx', 'agent_cx', 1, 'env_cx', 'idle', NULL, '{}', 0, 0, 'ca-sess-fake')`,
  ).run();

  return { sessionId: "sess_cx" };
}

describe("e2e codex round-trip (fake exec)", () => {
  beforeEach(() => {
    freshDbEnv();
    vi.clearAllMocks();
  });

  it("runs a text turn and captures thread_id + usage", async () => {
    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    const { sessionId } = await seedAgentEnvSession();

    let capturedStdin = "";
    fake.enqueueTurn({
      ndjson: readFixture("turn1.ndjson"),
      onStdin: (body) => {
        capturedStdin = body;
      },
    });

    const { runTurn } = await import("../src/sessions/driver");
    await runTurn(sessionId, [
      { kind: "text", eventId: "evt_1", text: "what is 2+2" },
    ]);

    const { getDb } = await import("../src/db/client");
    const db = getDb();

    const events = db
      .prepare(
        `SELECT type, payload_json, seq FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as { type: string; payload_json: string; seq: number }[];

    const types = events.map((e) => e.type);
    expect(types).toContain("session.status_running");
    expect(types).toContain("agent.message");
    expect(types).toContain("span.model_request_end");
    expect(types).toContain("session.status_idle");

    const msg = events.find((e) => e.type === "agent.message");
    const msgPayload = JSON.parse(msg!.payload_json) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(msgPayload.content[0].text).toBe("4");

    const idle = events.filter((e) => e.type === "session.status_idle").at(-1);
    expect(JSON.parse(idle!.payload_json)).toMatchObject({ stop_reason: { type: "end_turn" } });

    // Usage propagated from turn.completed
    const spanEnd = events.find((e) => e.type === "span.model_request_end");
    const spanPayload = JSON.parse(spanEnd!.payload_json) as {
      model_usage: { input_tokens: number; output_tokens: number };
    };
    expect(spanPayload.model_usage.input_tokens).toBe(12247);
    expect(spanPayload.model_usage.output_tokens).toBe(18);

    // thread_id captured as backend session id
    const row = db
      .prepare(
        `SELECT claude_session_id FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as { claude_session_id: string } | undefined;
    expect(row?.claude_session_id).toBe("019d769f-b31a-7a60-b657-d81f76a47bbc");

    // Stdin contains the prompt
    expect(capturedStdin).toContain("what is 2+2");
    expect(capturedStdin).toContain("OPENAI_API_KEY=");
    expect(capturedStdin).toContain("CODEX_API_KEY=");
  });

  it("emits tool_use + tool_result for command_execution items", async () => {
    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    const { sessionId } = await seedAgentEnvSession();

    fake.enqueueTurn({
      ndjson: readFixture("turn2.ndjson"),
    });

    const { runTurn } = await import("../src/sessions/driver");
    await runTurn(sessionId, [
      { kind: "text", eventId: "evt_2", text: "run echo hello" },
    ]);

    const { getDb } = await import("../src/db/client");
    const db = getDb();
    const events = db
      .prepare(
        `SELECT type, payload_json FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as { type: string; payload_json: string }[];

    const types = events.map((e) => e.type);
    expect(types).toContain("agent.tool_use");
    expect(types).toContain("agent.tool_result");
    expect(types).toContain("agent.message");

    const toolUse = events.find((e) => e.type === "agent.tool_use");
    const toolPayload = JSON.parse(toolUse!.payload_json) as {
      name: string;
      input: { command: string };
    };
    expect(toolPayload.name).toBe("command");
    expect(toolPayload.input.command).toBe("echo hello");

    const toolResult = events.find((e) => e.type === "agent.tool_result");
    const resultPayload = JSON.parse(toolResult!.payload_json) as { content: string };
    expect(resultPayload.content).toBe("hello\n");
  });

  it("rejects user.custom_tool_result for codex agents", async () => {
    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();
    const { sessionId } = await seedAgentEnvSession();

    const { runTurn } = await import("../src/sessions/driver");
    await runTurn(sessionId, [
      {
        kind: "tool_result",
        eventId: "evt_cr",
        custom_tool_use_id: "toolu_fake",
        content: [{ type: "text", text: "fake" }],
      },
    ]);

    const { getDb } = await import("../src/db/client");
    const events = getDb()
      .prepare(
        `SELECT type, payload_json FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as { type: string; payload_json: string }[];

    const errEvent = events.find((e) => e.type === "session.error");
    expect(errEvent).toBeDefined();
    const errPayload = JSON.parse(errEvent!.payload_json) as {
      error: { type: string; message: string };
    };
    expect(errPayload.error.message).toContain("codex");
  });
});
