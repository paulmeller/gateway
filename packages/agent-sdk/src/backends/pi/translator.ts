/**
 * Stateful translator: pi.dev coding agent JSON event stream → Managed
 * Agents events.
 *
 * pi.dev event model (emitted by `pi --mode json`):
 *
 *   - `session`              — session header, carries `id` (uuid)
 *   - `agent_start`          — agent loop begins
 *   - `turn_start`           — one reasoning turn begins
 *   - `message_start`        — assistant message about to stream
 *   - `message_update`       — partial assistant message delta
 *   - `message_end`          — full assistant message with `usage`
 *   - `tool_execution_start` — `{ toolCallId, toolName, args }`
 *   - `tool_execution_end`   — `{ toolCallId, toolName, result, isError }`
 *   - `turn_end`             — turn complete
 *   - `agent_end`            — agent loop done
 *
 * pi messages follow the @mariozechner/pi-ai shape:
 *   AssistantMessage = {
 *     role: "assistant",
 *     content: (TextContent | ThinkingContent | ToolCall)[],
 *     usage: { input, output, cacheRead, cacheWrite, totalTokens, cost: { total, ... } },
 *     stopReason: "stop" | "length" | "toolUse" | "error" | "aborted",
 *     ...
 *   }
 *
 * We translate `message_end` into one or more `agent.message` events (text
 * content) and use `tool_execution_start`/`tool_execution_end` for tool
 * lifecycle. Usage is accumulated across all message_end events in the
 * turn so multi-step agent loops aggregate cost correctly.
 *
 * Custom tool re-entry is NOT supported by pi in v1 — there is no
 * equivalent of claude's --input-format stream-json, so the buildTurn
 * function rejects toolResults.length > 0.
 */
import type {
  ToolClass,
  TranslatedEvent,
  Translator,
  TranslatorOptions,
  TurnResult,
  TurnUsage,
} from "../shared/translator-types";

interface PiTextContent {
  type: "text";
  text: string;
}
interface PiToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
type PiContentItem = PiTextContent | PiToolCall | { type: string };

interface PiAssistantMessage {
  role: "assistant";
  content?: PiContentItem[];
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}

export function createPiTranslator(opts: TranslatorOptions): Translator {
  const toolClass = new Map<string, ToolClass>();
  let sessionId: string | null = null;
  let sawCustom = false;
  let sawAny = false;

  // Accumulated usage across all message_end events in this turn.
  const usage: TurnUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_usd: 0,
  };

  let stopReason: TurnResult["stopReason"] = "end_turn";
  let numTurns = 0;

  function classify(name: string): ToolClass {
    if (opts.customToolNames.has(name)) return "custom";
    return "builtin";
  }

  function mapStopReason(pi: string | undefined): TurnResult["stopReason"] {
    switch (pi) {
      case "length":
        return "max_turns";
      case "error":
      case "aborted":
        return "error";
      default:
        return "end_turn";
    }
  }

  function emitAssistantMessage(
    msg: PiAssistantMessage,
    out: TranslatedEvent[],
  ): void {
    sawAny = true;
    const content = Array.isArray(msg.content) ? msg.content : [];

    for (const item of content) {
      if (item && item.type === "text") {
        const text = (item as PiTextContent).text;
        if (typeof text === "string" && text.length > 0) {
          out.push({
            type: "agent.message",
            payload: { content: [{ type: "text", text }] },
          });
        }
      }
      // ToolCall items are surfaced via tool_execution_start lifecycle
      // events instead, so we skip them here to avoid double-emitting.
    }

    if (msg.usage) {
      if (typeof msg.usage.input === "number") usage.input_tokens += msg.usage.input;
      if (typeof msg.usage.output === "number") usage.output_tokens += msg.usage.output;
      if (typeof msg.usage.cacheRead === "number") usage.cache_read_input_tokens += msg.usage.cacheRead;
      if (typeof msg.usage.cacheWrite === "number") usage.cache_creation_input_tokens += msg.usage.cacheWrite;
      if (msg.usage.cost && typeof msg.usage.cost.total === "number") {
        usage.cost_usd += msg.usage.cost.total;
      }
    }

    // Most recent stopReason wins (final assistant message in the loop).
    stopReason = mapStopReason(msg.stopReason);
  }

  function translate(raw: Record<string, unknown>): TranslatedEvent[] {
    const out: TranslatedEvent[] = [];
    if (!raw || typeof raw !== "object") return out;
    const type = String(raw.type ?? "");

    if (type === "session") {
      if (typeof raw.id === "string") sessionId = raw.id;
      return out;
    }

    if (type === "turn_start") {
      numTurns += 1;
      return out;
    }

    if (type === "message_end") {
      const msg = raw.message as PiAssistantMessage | undefined;
      if (msg && msg.role === "assistant") {
        emitAssistantMessage(msg, out);
      }
      return out;
    }

    if (type === "tool_execution_start") {
      const toolName = String(raw.toolName ?? "unknown");
      const toolId = String(raw.toolCallId ?? "");
      const args = (raw.args ?? {}) as Record<string, unknown>;

      const cls = classify(toolName);
      toolClass.set(toolId, cls);
      if (cls === "custom") sawCustom = true;
      sawAny = true;

      const useType = cls === "custom" ? "agent.custom_tool_use" : "agent.tool_use";
      out.push({
        type: useType,
        payload: {
          tool_use_id: toolId,
          name: toolName,
          input: args,
        },
      });
      return out;
    }

    if (type === "tool_execution_end") {
      const toolId = String(raw.toolCallId ?? "");
      const isError = raw.isError === true;
      const cls = toolClass.get(toolId);

      // Custom tools are handled by the client via user.custom_tool_result —
      // suppress the gateway-side tool_result for them.
      if (cls === "custom") return out;

      const result = raw.result;
      let content: string;
      if (typeof result === "string") {
        content = result;
      } else if (result == null) {
        content = "";
      } else {
        content = JSON.stringify(result);
      }

      out.push({
        type: "agent.tool_result",
        payload: {
          tool_use_id: toolId,
          content,
          is_error: isError,
        },
      });
      return out;
    }

    if (type === "agent_end") {
      sawAny = true;
      return out;
    }

    // Unknown event type — drop silently, translator is forward-compatible.
    return out;
  }

  function getTurnResult(): TurnResult | null {
    if (!sawAny) return null;
    return {
      stopReason: sawCustom ? "custom_tool_call" : stopReason,
      usage,
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
