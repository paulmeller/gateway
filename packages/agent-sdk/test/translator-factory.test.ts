import { describe, it, expect } from "vitest";
import { createFactoryTranslator } from "../src/backends/factory/translator";
import type { TranslatedEvent } from "../src/backends/shared/translator-types";

function run(events: Record<string, unknown>[]) {
  const translator = createFactoryTranslator({ customToolNames: new Set(), isFirstTurn: true });
  const out: TranslatedEvent[] = [];
  for (const e of events) {
    out.push(...translator.translate(e));
  }
  return { out, translator };
}

function runWithCustom(events: Record<string, unknown>[], customNames: string[]) {
  const translator = createFactoryTranslator({ customToolNames: new Set(customNames), isFirstTurn: true });
  const out: TranslatedEvent[] = [];
  for (const e of events) {
    out.push(...translator.translate(e));
  }
  return { out, translator };
}

describe("createFactoryTranslator", () => {
  it("extracts session_id from system init event", () => {
    const { translator } = run([
      { type: "system", subtype: "init", session_id: "factory-sess-1", model: "claude-sonnet-4-6" },
    ]);
    expect(translator.getBackendSessionId()).toBe("factory-sess-1");
  });

  it("system init produces no translated events", () => {
    const { out } = run([
      { type: "system", subtype: "init", session_id: "s1" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("translates assistant message to agent.message using text field", () => {
    const { out } = run([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "message", role: "assistant", text: "Hello from Factory!" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.message");
    expect((out[0].payload as any).content[0].text).toBe("Hello from Factory!");
  });

  it("ignores non-assistant messages", () => {
    const { out } = run([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "message", role: "user", text: "hi" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("translates tool_call to agent.tool_use", () => {
    const { out } = run([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "tool_call", toolName: "search", id: "tc1", parameters: { query: "test" } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("agent.tool_use");
    expect((out[0].payload as any).name).toBe("search");
    expect((out[0].payload as any).tool_use_id).toBe("tc1");
  });

  it("classifies custom tools as agent.custom_tool_use", () => {
    const { out } = runWithCustom([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "tool_call", toolName: "my_custom", id: "tc1", parameters: {} },
    ], ["my_custom"]);
    expect(out[0].type).toBe("agent.custom_tool_use");
  });

  it("translates tool_result for builtin tools", () => {
    const { out } = run([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "tool_call", toolName: "search", id: "tc1", parameters: {} },
      { type: "tool_result", id: "tc1", value: "found it", isError: false },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].type).toBe("agent.tool_result");
    expect((out[1].payload as any).content).toBe("found it");
  });

  it("suppresses tool_result for custom tools", () => {
    const { out } = runWithCustom([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "tool_call", toolName: "my_custom", id: "tc1", parameters: {} },
      { type: "tool_result", id: "tc1", value: "done" },
    ], ["my_custom"]);
    expect(out).toHaveLength(1); // only custom_tool_use
  });

  it("handles completion event", () => {
    const { translator } = run([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "message", role: "assistant", text: "hi" },
      { type: "completion", finalText: "hi", numTurns: 3, durationMs: 5000 },
    ]);
    const result = translator.getTurnResult();
    expect(result).not.toBeNull();
    expect(result!.stopReason).toBe("end_turn");
    expect(result!.num_turns).toBe(3);
  });

  it("returns custom_tool_call stop reason when custom tool used", () => {
    const { translator } = runWithCustom([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "tool_call", toolName: "my_custom", id: "tc1", parameters: {} },
      { type: "completion", finalText: "", numTurns: 1, durationMs: 1000 },
    ], ["my_custom"]);
    expect(translator.getTurnResult()!.stopReason).toBe("custom_tool_call");
  });

  it("translates error events to session.error", () => {
    const { out } = run([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "error", message: "Authentication failed" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("session.error");
    expect((out[0].payload as any).error.message).toBe("Authentication failed");
  });

  it("uses fallback for error without message", () => {
    const { out } = run([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "error" },
    ]);
    expect(out).toHaveLength(1);
    expect((out[0].payload as any).error.message).toBe("Unknown factory error");
  });

  it("factory usage is zeros (not provided by backend)", () => {
    const { translator } = run([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "message", role: "assistant", text: "hi" },
      { type: "completion" },
    ]);
    const result = translator.getTurnResult()!;
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
    expect(result.usage.cost_usd).toBe(0);
  });

  it("returns null turn result when nothing processed", () => {
    const { translator } = run([
      { type: "system", subtype: "init", session_id: "s1" },
    ]);
    expect(translator.getTurnResult()).toBeNull();
  });

  it("drops unknown event types silently", () => {
    const { out } = run([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "heartbeat", data: "ping" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("sawCustomToolUse tracks custom tool usage", () => {
    const { translator } = runWithCustom([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "tool_call", toolName: "my_custom", id: "tc1", parameters: {} },
    ], ["my_custom"]);
    expect(translator.sawCustomToolUse()).toBe(true);
  });
});
