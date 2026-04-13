/**
 * Unit test for the codex translator.
 *
 * Mirrors test/translator-opencode.test.ts against codex's NDJSON event
 * shapes: thread.started, item.completed (agent_message, command_execution,
 * mcp_tool_call, file_change), turn.completed, error.
 *
 * Key codex-specific behaviors:
 *   - translate() returns ARRAYS for command_execution and mcp_tool_call
 *     (tool_use + tool_result in one call)
 *   - turn.completed accumulates usage; getTurnResult() synthesizes the
 *     final result at end-of-stream (equivalent to opencompletions' finalize)
 *   - No cost_usd in current codex v0.118.0 usage output
 */
import { describe, it, expect } from "vitest";
import { createCodexTranslator } from "../src/backends/codex/translator";

function run(
  events: Array<Record<string, unknown>>,
  opts: { custom?: string[]; isFirstTurn?: boolean } = {},
) {
  const t = createCodexTranslator({
    customToolNames: new Set(opts.custom ?? []),
    isFirstTurn: opts.isFirstTurn ?? true,
  });
  const out: Array<{ type: string; payload: Record<string, unknown> }> = [];
  for (const raw of events) {
    for (const ev of t.translate(raw)) out.push(ev);
  }
  return { out, t };
}

describe("createCodexTranslator", () => {
  it("captures thread_id from thread.started", () => {
    const { t } = run([{ type: "thread.started", thread_id: "tid_abc" }]);
    expect(t.getBackendSessionId()).toBe("tid_abc");
  });

  it("drops turn.started silently", () => {
    const { out } = run([
      { type: "thread.started", thread_id: "tid_1" },
      { type: "turn.started" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("emits agent.message for item.completed{agent_message}", () => {
    const { out } = run([
      { type: "thread.started", thread_id: "tid_1" },
      { type: "item.completed", item: { id: "i_1", type: "agent_message", text: "hello" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.message");
    expect(out[0].payload).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("emits tool_use + tool_result for command_execution", () => {
    const { out } = run([
      { type: "thread.started", thread_id: "tid_1" },
      {
        type: "item.completed",
        item: { id: "i_2", type: "command_execution", command: "ls", output: "a.txt\nb.txt\n" },
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe("agent.tool_use");
    expect(out[0].payload).toEqual({
      tool_use_id: "i_2",
      name: "command",
      input: { command: "ls" },
    });
    expect(out[1].type).toBe("agent.tool_result");
    expect(out[1].payload).toEqual({
      tool_use_id: "i_2",
      content: "a.txt\nb.txt\n",
      is_error: false,
    });
  });

  it("emits tool_use + tool_result for mcp_tool_call", () => {
    const { out } = run([
      { type: "thread.started", thread_id: "tid_1" },
      {
        type: "item.completed",
        item: { id: "i_3", type: "mcp_tool_call", name: "search", input: { q: "hi" }, output: "results..." },
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe("agent.tool_use");
    expect(out[0].payload.name).toBe("search");
    expect(out[1].type).toBe("agent.tool_result");
    expect(out[1].payload.content).toBe("results...");
  });

  it("classifies mcp_tool_call as custom when name is in customToolNames", () => {
    const { out, t } = run(
      [
        { type: "thread.started", thread_id: "tid_1" },
        {
          type: "item.completed",
          item: { id: "i_4", type: "mcp_tool_call", name: "my_tool", input: {}, output: "ok" },
        },
      ],
      { custom: ["my_tool"] },
    );
    expect(out).toHaveLength(1); // only tool_use, NO tool_result for custom
    expect(out[0].type).toBe("agent.custom_tool_use");
    expect(t.sawCustomToolUse()).toBe(true);
  });

  it("emits agent.tool_use for file_change", () => {
    const { out } = run([
      { type: "thread.started", thread_id: "tid_1" },
      {
        type: "item.completed",
        item: { id: "i_5", type: "file_change", path: "README.md", action: "edit" },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.tool_use");
    expect(out[0].payload).toEqual({
      tool_use_id: "i_5",
      name: "file_edit",
      input: { path: "README.md", action: "edit" },
    });
  });

  it("accumulates usage across turn.completed events", () => {
    const { t } = run([
      { type: "thread.started", thread_id: "tid_1" },
      { type: "item.completed", item: { id: "i_0", type: "agent_message", text: "partial" } },
      { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } },
      { type: "turn.completed", usage: { input_tokens: 50, output_tokens: 5 } },
    ]);
    const result = t.getTurnResult();
    expect(result).not.toBeNull();
    expect(result!.usage.input_tokens).toBe(150);
    expect(result!.usage.output_tokens).toBe(15);
    expect(result!.usage.cost_usd).toBe(0); // codex doesn't emit cost_usd
    expect(result!.num_turns).toBe(2);
    expect(result!.stopReason).toBe("end_turn");
  });

  it("returns null from getTurnResult before any events", () => {
    const { t } = run([]);
    expect(t.getTurnResult()).toBeNull();
  });

  it("returns end_turn from getTurnResult when there's text but no turn.completed", () => {
    const { t } = run([
      { type: "thread.started", thread_id: "tid_1" },
      { type: "item.completed", item: { id: "i_0", type: "agent_message", text: "response" } },
    ]);
    const result = t.getTurnResult();
    expect(result!.stopReason).toBe("end_turn");
    expect(result!.num_turns).toBe(1); // fallback
  });

  it("returns custom_tool_call stopReason when custom tool was used", () => {
    const { t } = run(
      [
        { type: "thread.started", thread_id: "tid_1" },
        {
          type: "item.completed",
          item: { id: "i_6", type: "mcp_tool_call", name: "custom_fn", input: {} },
        },
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
      ],
      { custom: ["custom_fn"] },
    );
    expect(t.getTurnResult()!.stopReason).toBe("custom_tool_call");
  });

  it("drops error events silently", () => {
    const { out } = run([
      { type: "thread.started", thread_id: "tid_1" },
      { type: "error", message: "something broke" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("drops unknown event types silently", () => {
    const { out } = run([
      { type: "thread.started", thread_id: "tid_1" },
      { type: "something.new" },
      { type: "item.completed", item: { id: "i_0", type: "agent_message", text: "ok" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.message");
  });
});
