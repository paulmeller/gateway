/**
 * Stateful translator: Factory CLI stream-json NDJSON -> Managed Agents events.
 *
 * Factory CLI event model (emitted by `droid exec --output-format stream-json`):
 *   - `system` (subtype: "init") — session init with `session_id` and `model`
 *   - `message`    — assistant text (role: "assistant", text: string) NOTE: `text` not `content`
 *   - `tool_call`  — tool invocation (toolName, id, parameters)
 *   - `tool_result` — tool output (id, value, isError)
 *   - `completion`  — end of turn (finalText, numTurns, durationMs)
 *
 * Maps to Managed Agents events using the same Translator interface as other
 * backends.
 */
import type {
  ToolClass,
  TranslatedEvent,
  Translator,
  TranslatorOptions,
  TurnResult,
} from "../shared/translator-types";

export function createFactoryTranslator(opts: TranslatorOptions): Translator {
  const toolClass = new Map<string, ToolClass>();
  let sessionId: string | null = null;
  let lastText = "";
  let sawCustom = false;
  let sawCompletion = false;
  let numTurns = 0;
  let durationMs = 0;

  function classify(name: string): ToolClass {
    if (opts.customToolNames.has(name)) return "custom";
    return "builtin";
  }

  function translate(raw: Record<string, unknown>): TranslatedEvent[] {
    const out: TranslatedEvent[] = [];
    if (!raw || typeof raw !== "object") return out;
    const type = String(raw.type ?? "");

    // system init event
    if (type === "system" && raw.subtype === "init") {
      if (typeof raw.session_id === "string") sessionId = raw.session_id;
      return out;
    }

    // assistant message — note: Factory uses `text` not `content`
    if (type === "message" && raw.role === "assistant") {
      const text = typeof raw.text === "string" ? raw.text : "";
      if (text) {
        lastText = text;
        out.push({
          type: "agent.message",
          payload: { content: [{ type: "text", text }] },
        });
      }
      return out;
    }

    // tool call — note: Factory uses `toolName` not `tool_name`
    if (type === "tool_call") {
      const toolName = String(raw.toolName ?? "unknown");
      const toolId = String(raw.id ?? "");
      const parameters = (raw.parameters ?? {}) as Record<string, unknown>;

      const cls = classify(toolName);
      toolClass.set(toolId, cls);
      if (cls === "custom") sawCustom = true;

      const useType = cls === "custom" ? "agent.custom_tool_use" : "agent.tool_use";
      out.push({
        type: useType,
        payload: {
          tool_use_id: toolId,
          name: toolName,
          input: parameters,
        },
      });
      return out;
    }

    // tool result — note: Factory uses `value` not `output`
    if (type === "tool_result") {
      const toolId = String(raw.id ?? "");
      const value = typeof raw.value === "string" ? raw.value : JSON.stringify(raw.value ?? "");
      const isError = raw.isError === true;
      const cls = toolClass.get(toolId);

      // Only emit tool_result for builtin tools
      if (cls !== "custom") {
        out.push({
          type: "agent.tool_result",
          payload: {
            tool_use_id: toolId,
            content: value,
            is_error: isError,
          },
        });
      }
      return out;
    }

    // completion — end of turn
    if (type === "completion") {
      sawCompletion = true;
      if (typeof raw.finalText === "string") lastText = raw.finalText;
      if (typeof raw.numTurns === "number") numTurns = raw.numTurns;
      if (typeof raw.durationMs === "number") durationMs = raw.durationMs;
      return out;
    }

    if (type === "error") {
      const msg = (typeof raw.message === "string" ? raw.message : null) || "Unknown factory error";
      out.push({
        type: "session.error" as const,
        payload: { error: { type: "backend_error", message: msg } },
      });
      return out;
    }

    // Unknown event type — drop silently, translator is forward-compatible.
    return out;
  }

  function getTurnResult(): TurnResult | null {
    if (!sawCompletion && !lastText) return null;
    // Factory's completion event does not include token usage or cost.
    // We report zeros — usage tracking is best-effort for this backend.
    return {
      stopReason: sawCustom ? "custom_tool_call" : "end_turn",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cost_usd: 0,
      },
      num_turns: numTurns || 1,
    };
  }

  return {
    translate,
    getBackendSessionId: () => sessionId,
    getTurnResult,
    sawCustomToolUse: () => sawCustom,
  };
}
