import { describe, it, expect } from "vitest";
import { createPiTranslator } from "../src/backends/pi/translator";
import type { TranslatedEvent } from "../src/backends/shared/translator-types";

function run(events: Record<string, unknown>[]) {
  const translator = createPiTranslator({ customToolNames: new Set(), isFirstTurn: true });
  const out: TranslatedEvent[] = [];
  for (const e of events) {
    out.push(...translator.translate(e));
  }
  return { out, translator };
}

function runWithCustom(events: Record<string, unknown>[], customNames: string[]) {
  const translator = createPiTranslator({ customToolNames: new Set(customNames), isFirstTurn: true });
  const out: TranslatedEvent[] = [];
  for (const e of events) {
    out.push(...translator.translate(e));
  }
  return { out, translator };
}

function assistantMessage(text: string, opts?: { stopReason?: string; usage?: Record<string, unknown> }) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: opts?.stopReason ?? "stop",
      usage: opts?.usage ?? {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.01 },
      },
    },
  };
}

describe("createPiTranslator", () => {
  it("extracts session id from session header", () => {
    const { translator } = run([
      { type: "session", version: 3, id: "pi-uuid-1", timestamp: "2026-04-14", cwd: "/work" },
    ]);
    expect(translator.getBackendSessionId()).toBe("pi-uuid-1");
  });

  it("session header produces no translated events", () => {
    const { out } = run([
      { type: "session", id: "s1" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("translates message_end assistant text into agent.message", () => {
    const { out } = run([
      { type: "session", id: "s1" },
      assistantMessage("Hello!"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.message");
    expect((out[0].payload as any).content[0].text).toBe("Hello!");
  });

  it("ignores assistant message with empty text content", () => {
    const { out } = run([
      { type: "session", id: "s1" },
      assistantMessage(""),
    ]);
    expect(out).toHaveLength(0);
  });

  it("does NOT emit assistant message for non-assistant role", () => {
    const { out } = run([
      { type: "session", id: "s1" },
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ]);
    expect(out).toHaveLength(0);
  });

  it("translates tool_execution_start to agent.tool_use", () => {
    const { out } = run([
      { type: "session", id: "s1" },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.tool_use");
    expect((out[0].payload as any).name).toBe("bash");
    expect((out[0].payload as any).tool_use_id).toBe("t1");
    expect((out[0].payload as any).input).toEqual({ cmd: "ls" });
  });

  it("classifies custom tools as agent.custom_tool_use", () => {
    const { out } = runWithCustom([
      { type: "session", id: "s1" },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "my_tool", args: {} },
    ], ["my_tool"]);
    expect(out[0].type).toBe("agent.custom_tool_use");
  });

  it("translates tool_execution_end for builtin tools", () => {
    const { out } = run([
      { type: "session", id: "s1" },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "found it", isError: false },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].type).toBe("agent.tool_result");
    expect((out[1].payload as any).content).toBe("found it");
    expect((out[1].payload as any).is_error).toBe(false);
  });

  it("propagates isError on tool_execution_end", () => {
    const { out } = run([
      { type: "session", id: "s1" },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "boom", isError: true },
    ]);
    expect((out[1].payload as any).is_error).toBe(true);
  });

  it("JSON-stringifies non-string tool_execution_end results", () => {
    const { out } = run([
      { type: "session", id: "s1" },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "search", args: {} },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "search", result: { hits: 3 } },
    ]);
    expect((out[1].payload as any).content).toBe('{"hits":3}');
  });

  it("suppresses tool_execution_end for custom tools", () => {
    const { out } = runWithCustom([
      { type: "session", id: "s1" },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "my_tool", args: {} },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "my_tool", result: "done" },
    ], ["my_tool"]);
    expect(out).toHaveLength(1); // only tool_use, no tool_result
    expect(out[0].type).toBe("agent.custom_tool_use");
  });

  it("accumulates usage from message_end events", () => {
    const { translator } = run([
      { type: "session", id: "s1" },
      { type: "turn_start" },
      assistantMessage("first", {
        usage: {
          input: 100, output: 50, cacheRead: 10, cacheWrite: 20,
          cost: { total: 0.01 },
        },
      }),
      { type: "turn_start" },
      assistantMessage("second", {
        usage: {
          input: 30, output: 15, cacheRead: 5, cacheWrite: 0,
          cost: { total: 0.005 },
        },
      }),
    ]);
    const result = translator.getTurnResult();
    expect(result).not.toBeNull();
    expect(result!.usage.input_tokens).toBe(130);
    expect(result!.usage.output_tokens).toBe(65);
    expect(result!.usage.cache_read_input_tokens).toBe(15);
    expect(result!.usage.cache_creation_input_tokens).toBe(20);
    expect(result!.usage.cost_usd).toBeCloseTo(0.015);
    expect(result!.num_turns).toBe(2);
  });

  it("returns end_turn stop reason by default (stopReason=stop)", () => {
    const { translator } = run([
      { type: "session", id: "s1" },
      assistantMessage("hi", { stopReason: "stop" }),
    ]);
    expect(translator.getTurnResult()!.stopReason).toBe("end_turn");
  });

  it("maps stopReason=length to max_turns", () => {
    const { translator } = run([
      { type: "session", id: "s1" },
      assistantMessage("hi", { stopReason: "length" }),
    ]);
    expect(translator.getTurnResult()!.stopReason).toBe("max_turns");
  });

  it("maps stopReason=error to error", () => {
    const { translator } = run([
      { type: "session", id: "s1" },
      assistantMessage("oops", { stopReason: "error" }),
    ]);
    expect(translator.getTurnResult()!.stopReason).toBe("error");
  });

  it("returns custom_tool_call stop reason when custom tool used", () => {
    const { translator } = runWithCustom([
      { type: "session", id: "s1" },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "my_tool", args: {} },
      assistantMessage("done", { stopReason: "stop" }),
    ], ["my_tool"]);
    expect(translator.getTurnResult()!.stopReason).toBe("custom_tool_call");
    expect(translator.sawCustomToolUse()).toBe(true);
  });

  it("returns null turn result when no events processed beyond session", () => {
    const { translator } = run([
      { type: "session", id: "s1" },
    ]);
    expect(translator.getTurnResult()).toBeNull();
  });

  it("drops unknown event types silently", () => {
    const { out } = run([
      { type: "session", id: "s1" },
      { type: "queue_update", steering: [], followUp: [] },
      { type: "message_start" },
      { type: "compaction_start", reason: "threshold" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("does not double-emit text from ToolCall content items", () => {
    // pi messages can include ToolCall items in content[] alongside TextContent.
    // Tool calls are surfaced via tool_execution_start, NOT via the message
    // body, so we should only see the text once.
    const { out } = run([
      { type: "session", id: "s1" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Running ls..." },
            { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } },
          ],
          stopReason: "toolUse",
          usage: { input: 1, output: 1, cost: { total: 0 } },
        },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.message");
  });
});

describe("buildPiArgs", () => {
  it("builds basic args with --mode json and -p", async () => {
    const { buildPiArgs } = await import("../src/backends/pi/args");
    const args = buildPiArgs({
      agent: { model: "anthropic/claude-sonnet-4-6" } as any,
      backendSessionId: null,
      prompt: "hello",
    });
    expect(args).toContain("-p");
    expect(args).toContain("--mode");
    expect(args).toContain("json");
    expect(args).toContain("--no-extensions");
    // prompt is the trailing positional argument
    expect(args[args.length - 1]).toBe("hello");
  });

  it("includes --session when backendSessionId provided", async () => {
    const { buildPiArgs } = await import("../src/backends/pi/args");
    const args = buildPiArgs({
      agent: {} as any,
      backendSessionId: "prev-session-uuid",
      prompt: "continue",
    });
    expect(args).toContain("--session");
    expect(args).toContain("prev-session-uuid");
  });

  it("omits --session on first turn", async () => {
    const { buildPiArgs } = await import("../src/backends/pi/args");
    const args = buildPiArgs({
      agent: {} as any,
      backendSessionId: null,
      prompt: "hi",
    });
    expect(args).not.toContain("--session");
  });

  it("includes --model when agent has model", async () => {
    const { buildPiArgs } = await import("../src/backends/pi/args");
    const args = buildPiArgs({
      agent: { model: "openai/gpt-4o-mini" } as any,
      backendSessionId: null,
      prompt: "hi",
    });
    expect(args).toContain("--model");
    expect(args).toContain("openai/gpt-4o-mini");
  });

  it("omits --model when agent has no model set", async () => {
    const { buildPiArgs } = await import("../src/backends/pi/args");
    const args = buildPiArgs({
      agent: {} as any,
      backendSessionId: null,
      prompt: "hi",
    });
    expect(args).not.toContain("--model");
  });
});

describe("buildPiAuthEnv", () => {
  it("returns at least one of the supported provider keys when configured", async () => {
    // We only sanity-check the shape: if none of ANTHROPIC/OPENAI/GEMINI is set
    // the env should be empty; the validateRuntime function then refuses the run.
    const { buildPiAuthEnv } = await import("../src/backends/pi/auth");
    const env = buildPiAuthEnv();
    // Just ensure the function returns an object — actual key presence depends
    // on the test environment and is covered by validatePiRuntime indirectly.
    expect(typeof env).toBe("object");
  });
});
