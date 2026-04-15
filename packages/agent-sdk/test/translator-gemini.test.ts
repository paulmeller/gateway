import { describe, it, expect } from "vitest";
import { createGeminiTranslator } from "../src/backends/gemini/translator";
import type { TranslatedEvent } from "../src/backends/shared/translator-types";

function run(events: Record<string, unknown>[]) {
  const translator = createGeminiTranslator({ customToolNames: new Set(), isFirstTurn: true });
  const out: TranslatedEvent[] = [];
  for (const e of events) {
    out.push(...translator.translate(e));
  }
  return { out, translator };
}

function runWithCustom(events: Record<string, unknown>[], customNames: string[]) {
  const translator = createGeminiTranslator({ customToolNames: new Set(customNames), isFirstTurn: true });
  const out: TranslatedEvent[] = [];
  for (const e of events) {
    out.push(...translator.translate(e));
  }
  return { out, translator };
}

describe("createGeminiTranslator", () => {
  it("extracts session_id from init event", () => {
    const { translator } = run([
      { type: "init", session_id: "gemini-sess-1", model: "gemini-2.5-flash" },
    ]);
    expect(translator.getBackendSessionId()).toBe("gemini-sess-1");
  });

  it("init event produces no translated events", () => {
    const { out } = run([
      { type: "init", session_id: "s1", model: "gemini-2.5-flash" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("translates assistant message to agent.message", () => {
    const { out } = run([
      { type: "init", session_id: "s1" },
      { type: "message", role: "assistant", content: "Hello!" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.message");
    expect((out[0].payload as any).content[0].text).toBe("Hello!");
  });

  it("ignores user messages", () => {
    const { out } = run([
      { type: "init", session_id: "s1" },
      { type: "message", role: "user", content: "hi" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("ignores assistant message with empty content", () => {
    const { out } = run([
      { type: "init", session_id: "s1" },
      { type: "message", role: "assistant", content: "" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("translates tool_use to agent.tool_use", () => {
    const { out } = run([
      { type: "init", session_id: "s1" },
      { type: "tool_use", tool_name: "search", tool_id: "t1", parameters: { query: "test" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.tool_use");
    expect((out[0].payload as any).name).toBe("search");
    expect((out[0].payload as any).tool_use_id).toBe("t1");
    expect((out[0].payload as any).input).toEqual({ query: "test" });
  });

  it("classifies custom tools as agent.custom_tool_use", () => {
    const { out } = runWithCustom([
      { type: "init", session_id: "s1" },
      { type: "tool_use", tool_name: "my_tool", tool_id: "t1", parameters: {} },
    ], ["my_tool"]);
    expect(out[0].type).toBe("agent.custom_tool_use");
  });

  it("translates tool_result for builtin tools", () => {
    const { out } = run([
      { type: "init", session_id: "s1" },
      { type: "tool_use", tool_name: "search", tool_id: "t1", parameters: {} },
      { type: "tool_result", tool_id: "t1", output: "found it", is_error: false },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].type).toBe("agent.tool_result");
    expect((out[1].payload as any).content).toBe("found it");
  });

  it("suppresses tool_result for custom tools", () => {
    const { out } = runWithCustom([
      { type: "init", session_id: "s1" },
      { type: "tool_use", tool_name: "my_tool", tool_id: "t1", parameters: {} },
      { type: "tool_result", tool_id: "t1", output: "done" },
    ], ["my_tool"]);
    expect(out).toHaveLength(1); // only tool_use, no tool_result
    expect(out[0].type).toBe("agent.custom_tool_use");
  });

  it("accumulates usage from result event", () => {
    const { translator } = run([
      { type: "init", session_id: "s1" },
      { type: "message", role: "assistant", content: "hi" },
      { type: "result", status: "success", stats: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01, num_turns: 2 } },
    ]);
    const result = translator.getTurnResult();
    expect(result).not.toBeNull();
    expect(result!.usage.input_tokens).toBe(100);
    expect(result!.usage.output_tokens).toBe(50);
    expect(result!.usage.cost_usd).toBe(0.01);
    expect(result!.num_turns).toBe(2);
  });

  it("returns end_turn stop reason by default", () => {
    const { translator } = run([
      { type: "init", session_id: "s1" },
      { type: "message", role: "assistant", content: "hi" },
      { type: "result", status: "success", stats: {} },
    ]);
    expect(translator.getTurnResult()!.stopReason).toBe("end_turn");
  });

  it("returns custom_tool_call stop reason when custom tool used", () => {
    const { translator } = runWithCustom([
      { type: "init", session_id: "s1" },
      { type: "tool_use", tool_name: "my_tool", tool_id: "t1", parameters: {} },
      { type: "result", status: "success", stats: {} },
    ], ["my_tool"]);
    expect(translator.getTurnResult()!.stopReason).toBe("custom_tool_call");
    expect(translator.sawCustomToolUse()).toBe(true);
  });

  it("returns null turn result when no events processed", () => {
    const { translator } = run([
      { type: "init", session_id: "s1" },
    ]);
    expect(translator.getTurnResult()).toBeNull();
  });

  it("drops unknown event types silently", () => {
    const { out } = run([
      { type: "init", session_id: "s1" },
      { type: "some_future_event", data: "whatever" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("handles multiple assistant messages (delta streaming)", () => {
    const { out } = run([
      { type: "init", session_id: "s1" },
      { type: "message", role: "assistant", content: "Hello", delta: true },
      { type: "message", role: "assistant", content: " world!", delta: true },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe("agent.message");
    expect(out[1].type).toBe("agent.message");
  });
});

describe("buildGeminiArgs", () => {
  it("builds basic args with --prompt", async () => {
    const { buildGeminiArgs } = await import("../src/backends/gemini/args");
    const args = buildGeminiArgs({
      agent: { model: "gemini-2.5-flash" } as any,
      backendSessionId: null,
      prompt: "hello",
    });
    expect(args).toContain("--prompt");
    expect(args).toContain("hello");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--yolo");
    expect(args).not.toContain("--max-turns");
  });

  it("includes --resume when backendSessionId provided", async () => {
    const { buildGeminiArgs } = await import("../src/backends/gemini/args");
    const args = buildGeminiArgs({
      agent: { model: "gemini-2.5-flash" } as any,
      backendSessionId: "prev-session-123",
      prompt: "continue",
    });
    expect(args).toContain("--resume");
    expect(args).toContain("prev-session-123");
  });

  it("includes --model when agent has model", async () => {
    const { buildGeminiArgs } = await import("../src/backends/gemini/args");
    const args = buildGeminiArgs({
      agent: { model: "gemini-2.5-flash" } as any,
      backendSessionId: null,
    });
    expect(args).toContain("--model");
    expect(args).toContain("gemini-2.5-flash");
  });

  it("uses empty string for prompt when not provided", async () => {
    const { buildGeminiArgs } = await import("../src/backends/gemini/args");
    const args = buildGeminiArgs({
      agent: {} as any,
      backendSessionId: null,
    });
    const promptIdx = args.indexOf("--prompt");
    expect(args[promptIdx + 1]).toBe("");
  });

  it("does NOT include --max-turns (gemini CLI does not support it)", async () => {
    const { buildGeminiArgs } = await import("../src/backends/gemini/args");
    const args = buildGeminiArgs({
      agent: { model: "gemini-2.5-flash" } as any,
      backendSessionId: null,
      prompt: "test",
    });
    expect(args).not.toContain("--max-turns");
  });
});
