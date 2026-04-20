/**
 * M4 custom-tool round-trip test, using fake-exec.
 *
 * This test drives the driver directly with scripted NDJSON fixtures, not
 * real sprites.dev or real claude. It proves:
 *   1. Turn 1 with a user.message that triggers a custom tool emits
 *      agent.custom_tool_use + session.status_idle{stop_reason:"custom_tool_call"}
 *      and is sent to claude as plain text on stdin.
 *   2. Turn 2 with a tool_result input is sent to claude via the
 *      stream-json `--input-format` path, with a `{type:"user", message:{
 *      content:[{type:"tool_result", ...}]}}` frame on stdin.
 *   3. The resume turn emits the agent's final text message and a normal
 *      session.status_idle{stop_reason:"end_turn"}.
 *
 * See also test/e2e-custom-tool-real.test.ts (creds-gated) for the real
 * round-trip test that validates claude actually parses the stream-json
 * user frame with a tool_result block.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Hoisted mocks — must be at module top. Vitest hoists `vi.mock` calls above
// all imports, including the `await import()` calls in the test bodies below.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-ct-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  // Set SPRITE_TOKEN so config doesn't throw on exec-adjacent lookups.
  process.env.SPRITE_TOKEN = "test-token";
  // Set a fake ANTHROPIC_API_KEY so claudeBackend.validateRuntime passes.
  // The test uses fake-exec so this value is never transmitted anywhere.
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
  const file = path.join(__dirname, "fixtures/claude-stream", name);
  const body = fs.readFileSync(file, "utf8");
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function seedAgentEnvSession(): Promise<{ sessionId: string }> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();

  db.prepare(
    `INSERT INTO agents (id, current_version, name, created_at, updated_at)
     VALUES ('agent_ct', 1, 't', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_versions
       (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
     VALUES ('agent_ct', 1, 'claude-sonnet-4-6', NULL, ?, '{}', 0)`,
  ).run(
    JSON.stringify([
      { type: "agent_toolset_20260401" },
      {
        type: "custom",
        name: "get_weather",
        description: "Return weather for a city",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]),
  );
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, created_at)
     VALUES ('env_ct', 't', '{}', 'ready', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, created_at, updated_at, sprite_name
     ) VALUES ('sess_ct', 'agent_ct', 1, 'env_ct', 'idle', NULL, '{}', 0, 0, 'ca-sess-fake')`,
  ).run();

  return { sessionId: "sess_ct" };
}

describe("e2e custom tool round-trip (fake exec)", () => {
  beforeEach(() => {
    freshDbEnv();
    vi.clearAllMocks();
  });

  it("runs a custom tool through stop_reason:custom_tool_call and resumes via stream-json", async () => {
    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    const { sessionId } = await seedAgentEnvSession();

    // Turn 1: scripted custom tool call
    let turn1Stdin = "";
    fake.enqueueTurn({
      ndjson: readFixture("custom-tool-turn1.ndjson"),
      onStdin: (body) => {
        turn1Stdin = body;
      },
    });

    const { runTurn } = await import("../src/sessions/driver");
    await runTurn(sessionId, [
      { kind: "text", eventId: "evt_1", text: "what's the weather in Sydney?" },
    ]);

    // Assertions for turn 1
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    const events1 = db
      .prepare(
        `SELECT type, payload_json, seq FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as { type: string; payload_json: string; seq: number }[];

    const types1 = events1.map((e) => e.type);
    expect(types1).toContain("session.status_running");
    expect(types1).toContain("span.model_request_start");
    expect(types1).toContain("agent.custom_tool_use");
    expect(types1).toContain("span.model_request_end");
    expect(types1).toContain("session.status_idle");

    const customToolEvent = events1.find((e) => e.type === "agent.custom_tool_use");
    expect(customToolEvent).toBeDefined();
    const toolPayload = JSON.parse(customToolEvent!.payload_json) as {
      tool_use_id: string;
      name: string;
      input: { city: string };
    };
    expect(toolPayload.name).toBe("get_weather");
    expect(toolPayload.input.city).toBe("Sydney");
    expect(toolPayload.tool_use_id).toBe("toolu_fixture_01");

    const idleEvent1 = events1.filter((e) => e.type === "session.status_idle").at(-1);
    const idlePayload1 = JSON.parse(idleEvent1!.payload_json) as { stop_reason: { type: string; event_ids?: string[] } };
    expect(idlePayload1.stop_reason.type).toBe("requires_action");
    expect(idlePayload1.stop_reason.event_ids).toBeDefined();

    // Turn 1 stdin should be plain text (env-block + blank line + prompt),
    // NOT a stream-json user frame.
    expect(turn1Stdin).toContain("what's the weather in Sydney?");
    expect(turn1Stdin).not.toContain('"type":"user"');
    expect(turn1Stdin).not.toContain('"tool_result"');

    // Session row should have captured the claude_session_id
    const row1 = db
      .prepare(
        `SELECT claude_session_id, status FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as { claude_session_id: string; status: string } | undefined;
    expect(row1?.claude_session_id).toBe("cc_sess_fixture_01");
    expect(row1?.status).toBe("idle");

    // Turn 2: resume with a tool_result input → should fire the stream-json path
    let turn2Stdin = "";
    fake.enqueueTurn({
      ndjson: readFixture("custom-tool-turn2.ndjson"),
      onStdin: (body) => {
        turn2Stdin = body;
      },
    });

    await runTurn(sessionId, [
      {
        kind: "tool_result",
        eventId: "evt_2",
        custom_tool_use_id: "toolu_fixture_01",
        content: [{ type: "text", text: "Sydney: 18C sunny" }],
      },
    ]);

    // Turn 2 stdin should be a stream-json user frame containing a tool_result
    // block. The stdin is env-block + blank line + <prompt>, where <prompt>
    // here is the JSON-encoded user frame. Split at the double-newline.
    expect(turn2Stdin).toContain('"type":"user"');
    expect(turn2Stdin).toContain('"tool_result"');
    expect(turn2Stdin).toContain("toolu_fixture_01");
    expect(turn2Stdin).toContain("Sydney: 18C sunny");

    const sepIdx = turn2Stdin.indexOf("\n\n");
    expect(sepIdx).toBeGreaterThanOrEqual(0);
    const jsonBody = turn2Stdin.slice(sepIdx + 2).trim();
    const parsedFrame = JSON.parse(jsonBody) as {
      type: string;
      message: { role: string; content: Array<{ type: string; tool_use_id?: string }> };
    };
    expect(parsedFrame.type).toBe("user");
    expect(parsedFrame.message.role).toBe("user");
    expect(parsedFrame.message.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_fixture_01",
    });

    // Assertions for turn 2 events
    const events2 = db
      .prepare(
        `SELECT type, payload_json, seq FROM events WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as { type: string; payload_json: string; seq: number }[];

    const agentMessages = events2
      .filter((e) => e.type === "agent.message")
      .map((e) => JSON.parse(e.payload_json) as { content: Array<{ text: string }> });
    expect(agentMessages.some((m) => m.content.some((c) => c.text.includes("Sydney is 18")))).toBe(
      true,
    );

    const idleEvents = events2.filter((e) => e.type === "session.status_idle");
    const finalIdle = idleEvents.at(-1)!;
    const finalIdlePayload = JSON.parse(finalIdle.payload_json) as { stop_reason: { type: string } };
    expect(finalIdlePayload.stop_reason).toEqual({ type: "end_turn" });
  });
});
