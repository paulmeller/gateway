import { describe, it, expect } from "vitest";
import { createClaudeTranslator as createTranslator } from "../src/backends/claude/translator";

function run(
  events: Array<Record<string, unknown>>,
  opts: { custom?: string[]; isFirstTurn?: boolean } = {},
) {
  const t = createTranslator({
    customToolNames: new Set(opts.custom ?? []),
    isFirstTurn: opts.isFirstTurn ?? true,
  });
  const out: Array<{ type: string; payload: unknown }> = [];
  for (const e of events) {
    for (const tr of t.translate(e)) out.push(tr);
  }
  return { out, translator: t };
}

describe("translator", () => {
  it("captures claude_session_id from system.init", () => {
    const { out, translator } = run([
      { type: "system", subtype: "init", session_id: "claude-sid-123", model: "claude-sonnet-4-6" },
    ]);
    expect(out).toEqual([]);
    expect(translator.getBackendSessionId()).toBe("claude-sid-123");
  });

  it("splits assistant text blocks into agent.message events", () => {
    const { out } = run([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: " world" },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);
    expect(out).toEqual([
      { type: "agent.message", payload: { content: [{ type: "text", text: "hello" }] } },
      { type: "agent.message", payload: { content: [{ type: "text", text: " world" }] } },
    ]);
  });

  it("passes through thinking blocks as agent.thinking", () => {
    const { out } = run([
      {
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "let me think..." }] },
      },
    ]);
    expect(out).toEqual([
      {
        type: "agent.thinking",
        payload: { content: [{ type: "thinking", thinking: "let me think..." }] },
      },
    ]);
  });

  it("classifies built-in tool_use as agent.tool_use", () => {
    const { out } = run([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu_1", name: "Read", input: { path: "a.txt" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "file contents", is_error: false },
          ],
        },
      },
    ]);
    expect(out[0]).toEqual({
      type: "agent.tool_use",
      payload: { tool_use_id: "tu_1", name: "Read", input: { path: "a.txt" } },
    });
    expect(out[1]).toEqual({
      type: "agent.tool_result",
      payload: { tool_use_id: "tu_1", content: "file contents", is_error: false },
    });
  });

  it("classifies mcp__-prefixed tool as agent.mcp_tool_use + agent.mcp_tool_result", () => {
    const { out } = run([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_2",
              name: "mcp__github__get_issue",
              input: { number: 1 },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_2", content: "issue data" },
          ],
        },
      },
    ]);
    expect(out[0]).toEqual({
      type: "agent.mcp_tool_use",
      payload: {
        tool_use_id: "tu_2",
        server_name: "github",
        tool_name: "get_issue",
        input: { number: 1 },
      },
    });
    expect(out[1]).toEqual({
      type: "agent.mcp_tool_result",
      payload: { tool_use_id: "tu_2", content: "issue data", is_error: false },
    });
  });

  it("classifies custom tools as agent.custom_tool_use (no matching tool_result)", () => {
    const { out, translator } = run(
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tu_3", name: "get_weather", input: { city: "Sydney" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu_3", content: "irrelevant" },
            ],
          },
        },
      ],
      { custom: ["get_weather"] },
    );
    // custom tool_use is emitted, but the tool_result from claude is suppressed
    // (client is expected to reply with user.custom_tool_result)
    expect(out).toEqual([
      {
        type: "agent.custom_tool_use",
        payload: { tool_use_id: "tu_3", name: "get_weather", input: { city: "Sydney" } },
      },
    ]);
    expect(translator.sawCustomToolUse()).toBe(true);
  });

  it("produces a turn result with stop_reason end_turn on success", () => {
    const { translator } = run([
      {
        type: "result",
        subtype: "success",
        num_turns: 1,
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ]);
    const tr = translator.getTurnResult()!;
    expect(tr.stopReason).toBe("end_turn");
    expect(tr.num_turns).toBe(1);
    expect(tr.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.01,
    });
  });

  it("stop_reason maps error_max_turns → max_turns", () => {
    const { translator } = run([
      { type: "result", subtype: "error_max_turns", num_turns: 10, usage: {} },
    ]);
    expect(translator.getTurnResult()?.stopReason).toBe("max_turns");
  });

  it("stop_reason is custom_tool_call when a custom tool was used", () => {
    const { translator } = run(
      [
        {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "tu_4", name: "ping", input: {} }],
          },
        },
        { type: "result", subtype: "success", num_turns: 1, usage: {} },
      ],
      { custom: ["ping"] },
    );
    expect(translator.getTurnResult()?.stopReason).toBe("custom_tool_call");
  });
});
