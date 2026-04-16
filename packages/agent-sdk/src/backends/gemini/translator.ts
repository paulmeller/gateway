/**
 * Stateful translator: Gemini CLI stream-json NDJSON -> Managed Agents events.
 *
 * Gemini CLI event model (emitted by `gemini -p --output-format stream-json`):
 *   - `init`         — session init with `session_id` and `model`
 *   - `message`      — assistant text message (role: "assistant", content: string)
 *   - `tool_use`     — tool invocation (tool_name, tool_id, parameters)
 *   - `tool_result`  — tool output (tool_id, output, is_error?)
 *   - `result`       — end of turn with status and usage stats
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

export function createGeminiTranslator(opts: TranslatorOptions): Translator {
  const toolClass = new Map<string, ToolClass>();
  let sessionId: string | null = null;
  let lastText = "";
  let sawCustom = false;

  // Usage from the result event
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let numTurns = 0;
  let sawResult = false;

  function classify(name: string): ToolClass {
    if (opts.customToolNames.has(name)) return "custom";
    return "builtin";
  }

  function translate(raw: Record<string, unknown>): TranslatedEvent[] {
    const out: TranslatedEvent[] = [];
    if (!raw || typeof raw !== "object") return out;
    const type = String(raw.type ?? "");

    if (type === "init") {
      if (typeof raw.session_id === "string") sessionId = raw.session_id;
      return out;
    }

    if (type === "message" && raw.role === "assistant") {
      const content = typeof raw.content === "string" ? raw.content : "";
      if (content) {
        lastText = content;
        out.push({
          type: "agent.message",
          payload: { content: [{ type: "text", text: content }] },
        });
      }
      return out;
    }

    if (type === "tool_use") {
      const toolName = String(raw.tool_name ?? "unknown");
      const toolId = String(raw.tool_id ?? "");
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

    if (type === "tool_result") {
      const toolId = String(raw.tool_id ?? "");
      const output = typeof raw.output === "string" ? raw.output : JSON.stringify(raw.output ?? "");
      const isError = raw.is_error === true;
      const cls = toolClass.get(toolId);

      // Only emit tool_result for builtin tools — custom tools are handled
      // by the client via user.custom_tool_result
      if (cls !== "custom") {
        out.push({
          type: "agent.tool_result",
          payload: {
            tool_use_id: toolId,
            content: output,
            is_error: isError,
          },
        });
      }
      return out;
    }

    if (type === "result") {
      sawResult = true;
      const stats = (raw.stats ?? {}) as Record<string, unknown>;
      if (typeof stats.input_tokens === "number") inputTokens = stats.input_tokens;
      if (typeof stats.output_tokens === "number") outputTokens = stats.output_tokens;
      if (typeof stats.cost_usd === "number") costUsd = stats.cost_usd;
      if (typeof stats.num_turns === "number") numTurns = stats.num_turns;
      return out;
    }

    // Unknown event type — drop silently, translator is forward-compatible.
    return out;
  }

  function getTurnResult(): TurnResult | null {
    if (!sawResult && !lastText) return null;
    return {
      stopReason: sawCustom ? "custom_tool_call" : "end_turn",
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cost_usd: costUsd,
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
