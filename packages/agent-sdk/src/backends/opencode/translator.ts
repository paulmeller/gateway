/**
 * Stateful translator: opencode NDJSON → Managed Agents events.
 *
 * Ported from
 * 
 *
 * Opencode's event model (emitted by `opencode run --format json`):
 *   - `step_start` — an agent step is starting. Carries `sessionID` on the
 *     root event object. First occurrence marks the first turn.
 *   - `text` — assistant text content, in `part.text`
 *   - `tool_use` — assistant is calling a tool, in `part.tool`,
 *     `part.callID`, `part.state.input`
 *   - `step_finish` — end of a step. Carries `part.cost`, `part.tokens`,
 *     `part.reason`. `reason === "stop"` signals turn end.
 *
 * Note: opencode does NOT emit tool_result events in its NDJSON stream —
 * tool execution is handled by opencode's own plugins/built-ins, and the
 * results are folded into subsequent assistant content. This translator
 * does not need a tool_result case.
 *
 * The Managed Agents side (our taxonomy) this maps to:
 *   - system.init (internal state only — driver emits session.status_running)
 *   - agent.message for text
 *   - agent.tool_use / agent.custom_tool_use based on customToolNames
 *   - result → TurnResult with stop_reason "end_turn" + usage aggregation
 */
import type {
  ToolClass,
  TranslatedEvent,
  Translator,
  TranslatorOptions,
  TurnResult,
  TurnUsage,
} from "../shared/translator-types";

interface OpencodePart {
  text?: string;
  tool?: string;
  callID?: string;
  id?: string;
  state?: { input?: unknown };
  cost?: number;
  tokens?: { input?: number; output?: number };
  reason?: string;
}

export function createOpencodeTranslator(opts: TranslatorOptions): Translator {
  const toolClass = new Map<string, ToolClass>();
  let sessionId: string | null = null;
  let seenFirstStep = false;
  let sawCustom = false;
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let stepCount = 0;
  let turnResult: TurnResult | null = null;

  function classify(name: string): ToolClass {
    if (opts.customToolNames.has(name)) return "custom";
    // Opencode tools don't use the `mcp__` prefix convention; treat
    // everything else as a built-in tool for now. (Future: if opencode
    // exposes MCP tools with a distinct prefix, classify them here.)
    return "builtin";
  }

  function translate(raw: Record<string, unknown>): TranslatedEvent[] {
    const out: TranslatedEvent[] = [];
    if (!raw || typeof raw !== "object") return out;

    // Opencode puts sessionID on the root of every event that has session
    // context (step_start, text, tool_use, step_finish). We track it in
    // state and expose via getBackendSessionId.
    if (typeof raw.sessionID === "string" && raw.sessionID) {
      sessionId = raw.sessionID;
    }

    const type = String(raw.type ?? "");

    switch (type) {
      case "step_start": {
        stepCount++;
        if (!seenFirstStep) {
          seenFirstStep = true;
          // session.status_running is emitted by the driver, not the translator.
          // We only track state here.
        }
        return out;
      }

      case "text": {
        const part = (raw.part as OpencodePart | undefined) ?? {};
        const text = part.text ?? "";
        if (text) {
          out.push({
            type: "agent.message",
            payload: {
              content: [{ type: "text", text }],
            },
          });
        }
        return out;
      }

      case "tool_use": {
        const part = (raw.part as OpencodePart | undefined) ?? {};
        const toolUseId = part.callID ?? part.id ?? "";
        const name = part.tool ?? "unknown";
        const input = part.state?.input ?? {};
        if (!toolUseId) return out;

        const cls = classify(name);
        toolClass.set(toolUseId, cls);
        if (cls === "custom") {
          sawCustom = true;
          out.push({
            type: "agent.custom_tool_use",
            payload: { tool_use_id: toolUseId, name, input },
          });
        } else {
          out.push({
            type: "agent.tool_use",
            payload: { tool_use_id: toolUseId, name, input },
          });
        }
        return out;
      }

      case "step_finish": {
        const part = (raw.part as OpencodePart | undefined) ?? {};
        totalCostUsd += part.cost ?? 0;
        if (part.tokens) {
          totalInputTokens += part.tokens.input ?? 0;
          totalOutputTokens += part.tokens.output ?? 0;
        }
        if (part.reason === "stop") {
          const usage: TurnUsage = {
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cost_usd: totalCostUsd,
          };
          const stopReason: TurnResult["stopReason"] = sawCustom
            ? "custom_tool_call"
            : "end_turn";
          turnResult = {
            stopReason,
            usage,
            num_turns: stepCount,
          };
        }
        // Non-"stop" step_finish: just accumulate, no turn result yet
        return out;
      }

      default:
        // Unrecognized — drop silently, translator is forward-compatible.
        return out;
    }
  }

  return {
    translate,
    getBackendSessionId: () => sessionId,
    getTurnResult: () => turnResult,
    sawCustomToolUse: () => sawCustom,
  };
}
