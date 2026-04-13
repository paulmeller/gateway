/**
 * Unit test for the opencode translator.
 *
 * Mirrors test/translator.test.ts but against opencode's NDJSON event shapes:
 *   - step_start captures sessionID
 *   - text emits agent.message
 *   - tool_use emits agent.tool_use / agent.custom_tool_use
 *   - step_finish with reason:"stop" sets turn result with end_turn
 *   - step_finish with other reasons accumulates silently
 */
import { describe, it, expect } from "vitest";
import { createOpencodeTranslator } from "../src/backends/opencode/translator";

function run(
  events: Array<Record<string, unknown>>,
  opts: { custom?: string[]; isFirstTurn?: boolean } = {},
) {
  const t = createOpencodeTranslator({
    customToolNames: new Set(opts.custom ?? []),
    isFirstTurn: opts.isFirstTurn ?? true,
  });
  const out: Array<{ type: string; payload: Record<string, unknown> }> = [];
  for (const raw of events) {
    for (const ev of t.translate(raw)) out.push(ev);
  }
  return { out, t };
}

describe("createOpencodeTranslator", () => {
  it("captures sessionID from step_start", () => {
    const { t } = run([
      { type: "step_start", sessionID: "ses_abc_123", part: {} },
    ]);
    expect(t.getBackendSessionId()).toBe("ses_abc_123");
  });

  it("inherits sessionID across subsequent events even if they omit it", () => {
    const { t } = run([
      { type: "step_start", sessionID: "ses_xyz", part: {} },
      { type: "text", part: { text: "hi" } }, // no sessionID on this event
    ]);
    expect(t.getBackendSessionId()).toBe("ses_xyz");
  });

  it("emits agent.message for text events", () => {
    const { out } = run([
      { type: "step_start", sessionID: "ses_1", part: {} },
      { type: "text", sessionID: "ses_1", part: { text: "hello world" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.message");
    expect(out[0].payload).toEqual({
      content: [{ type: "text", text: "hello world" }],
    });
  });

  it("drops text events with empty text", () => {
    const { out } = run([
      { type: "step_start", sessionID: "ses_1", part: {} },
      { type: "text", sessionID: "ses_1", part: { text: "" } },
    ]);
    expect(out).toHaveLength(0);
  });

  it("classifies unknown tool_use as built-in", () => {
    const { out } = run([
      { type: "step_start", sessionID: "ses_1", part: {} },
      {
        type: "tool_use",
        sessionID: "ses_1",
        part: {
          callID: "toolu_1",
          tool: "read_file",
          state: { input: { path: "README.md" } },
        },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.tool_use");
    expect(out[0].payload).toEqual({
      tool_use_id: "toolu_1",
      name: "read_file",
      input: { path: "README.md" },
    });
  });

  it("classifies tool_use as custom when the name is in customToolNames", () => {
    const { out, t } = run(
      [
        { type: "step_start", sessionID: "ses_1", part: {} },
        {
          type: "tool_use",
          sessionID: "ses_1",
          part: {
            callID: "toolu_2",
            tool: "get_weather",
            state: { input: { city: "Sydney" } },
          },
        },
      ],
      { custom: ["get_weather"] },
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.custom_tool_use");
    expect(out[0].payload.name).toBe("get_weather");
    expect(t.sawCustomToolUse()).toBe(true);
  });

  it("falls back to `id` when `callID` is missing on tool_use", () => {
    const { out } = run([
      { type: "step_start", sessionID: "ses_1", part: {} },
      {
        type: "tool_use",
        sessionID: "ses_1",
        part: { id: "legacy-id", tool: "read_file", state: { input: {} } },
      },
    ]);
    expect(out[0].payload.tool_use_id).toBe("legacy-id");
  });

  it("drops tool_use events with no id at all", () => {
    const { out } = run([
      { type: "step_start", sessionID: "ses_1", part: {} },
      { type: "tool_use", sessionID: "ses_1", part: { tool: "read_file" } },
    ]);
    expect(out).toHaveLength(0);
  });

  it("emits turn result with end_turn on step_finish{reason:stop}", () => {
    const { t } = run([
      { type: "step_start", sessionID: "ses_1", part: {} },
      { type: "text", sessionID: "ses_1", part: { text: "response" } },
      {
        type: "step_finish",
        sessionID: "ses_1",
        part: {
          reason: "stop",
          cost: 0.0042,
          tokens: { input: 100, output: 50 },
        },
      },
    ]);
    const result = t.getTurnResult();
    expect(result).not.toBeNull();
    expect(result!.stopReason).toBe("end_turn");
    expect(result!.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cost_usd: 0.0042,
    });
    expect(result!.num_turns).toBe(1);
  });

  it("accumulates cost and tokens across non-stop step_finish events", () => {
    const { t } = run([
      { type: "step_start", sessionID: "ses_1", part: {} },
      {
        type: "step_finish",
        sessionID: "ses_1",
        part: { reason: "tool_use", cost: 0.001, tokens: { input: 10, output: 5 } },
      },
      { type: "step_start", sessionID: "ses_1", part: {} },
      {
        type: "step_finish",
        sessionID: "ses_1",
        part: { reason: "stop", cost: 0.002, tokens: { input: 20, output: 15 } },
      },
    ]);
    const result = t.getTurnResult();
    expect(result!.usage.cost_usd).toBeCloseTo(0.003);
    expect(result!.usage.input_tokens).toBe(30);
    expect(result!.usage.output_tokens).toBe(20);
    expect(result!.num_turns).toBe(2);
  });

  it("returns null turn result when no step_finish{stop} seen yet", () => {
    const { t } = run([
      { type: "step_start", sessionID: "ses_1", part: {} },
      { type: "text", sessionID: "ses_1", part: { text: "mid-turn" } },
    ]);
    expect(t.getTurnResult()).toBeNull();
  });

  it("uses custom_tool_call stop_reason when a custom tool was emitted", () => {
    const { t } = run(
      [
        { type: "step_start", sessionID: "ses_1", part: {} },
        {
          type: "tool_use",
          sessionID: "ses_1",
          part: { callID: "toolu_1", tool: "secret_number", state: { input: {} } },
        },
        {
          type: "step_finish",
          sessionID: "ses_1",
          part: { reason: "stop", cost: 0, tokens: { input: 10, output: 5 } },
        },
      ],
      { custom: ["secret_number"] },
    );
    expect(t.getTurnResult()!.stopReason).toBe("custom_tool_call");
  });

  it("drops unknown event types silently", () => {
    const { out } = run([
      { type: "step_start", sessionID: "ses_1", part: {} },
      { type: "something_weird", sessionID: "ses_1", part: {} },
      { type: "text", sessionID: "ses_1", part: { text: "ok" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.message");
  });
});
