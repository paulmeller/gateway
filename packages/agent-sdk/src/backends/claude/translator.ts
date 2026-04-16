/**
 * Stateful translator: claude -p stream-json NDJSON → Managed Agents events.
 *
 * The translator is the single source of truth for the Managed Agents event
 * taxonomy. It consumes raw NDJSON objects and returns an array of partially-
 * shaped Managed Agents event payloads for each line. The driver is
 * responsible for wrapping them with `{id, seq, session_id, processed_at}`
 * via `lib/sessions/bus.ts`.
 *
 * Tracked state:
 *   - latest `claude_session_id` (from `system.init`) — re-captured every
 *     turn, exposed via `getBackendSessionId()`
 *   - tool_use_id → classification cache (builtin / mcp / custom) so
 *     matching tool_result events route to the right MA type
 *   - cumulative usage deltas to apply on `span.model_request_end`
 *   - whether this turn involved a custom tool so `stop_reason` becomes
 *     `custom_tool_call`
 *
 * Span events are synthesized once per turn by the driver (one start after
 * `session.status_running`, one end before `session.status_idle`). The
 * translator supplies the `model_usage` fields to attach to the end event.
 */
import { BUILT_IN_TOOL_NAMES } from "../../types";
import { newId } from "../../util/ids";
import type {
  ToolClass,
  TranslatedEvent,
  Translator,
  TranslatorOptions,
  TurnResult,
  TurnUsage,
} from "../shared/translator-types";

interface ClaudeContentBlock {
  type: string;
  id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeMessage {
  content?: ClaudeContentBlock[];
  usage?: Partial<TurnUsage> & {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const BUILT_IN_SET = new Set<string>(BUILT_IN_TOOL_NAMES);

export function createClaudeTranslator(opts: TranslatorOptions): Translator {
  const toolClass = new Map<string, ToolClass>();
  // tool_use_id → span_id we minted at tool_use time, so the matching
  // tool_result can emit span.tool_call_end with the same id. Only
  // populated when `opts.turnSpanId` is set (observability enabled).
  const toolSpan = new Map<string, string>();
  // tool_use_id → { name, start_ms } for richer span payloads.
  const toolMeta = new Map<string, { name: string; startMs: number }>();
  let claudeSessionId: string | null = null;
  let sawInit = false;
  let sawCustom = false;
  let turnResult: TurnResult | null = null;

  function classify(name: string): ToolClass {
    if (BUILT_IN_SET.has(name)) return "builtin";
    if (name.startsWith("mcp__")) return "mcp";
    if (opts.customToolNames.has(name)) return "custom";
    // Unknown — treat as builtin (safer default for forward-compat)
    return "builtin";
  }

  function translate(raw: Record<string, unknown>): TranslatedEvent[] {
    const out: TranslatedEvent[] = [];
    const type = String(raw.type ?? "");

    if (type === "system") {
      const subtype = raw.subtype as string | undefined;
      if (subtype === "init") {
        if (typeof raw.session_id === "string") {
          claudeSessionId = raw.session_id;
        }
        // Only emit status_running on the first turn of the session — later
        // turns driven by --resume reuse the existing running status that
        // the driver already emitted before spawning exec.
        if (!sawInit && opts.isFirstTurn) {
          sawInit = true;
          // status_running is emitted by the driver, not the translator.
        }
        sawInit = true;
      }
      return out;
    }

    if (type === "assistant") {
      const msg = (raw.message as ClaudeMessage | undefined) ?? {};
      const blocks = msg.content ?? [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          out.push({
            type: "agent.message",
            payload: {
              content: [{ type: "text", text: block.text }],
            },
          });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          out.push({
            type: "agent.thinking",
            payload: {
              content: [{ type: "thinking", thinking: block.thinking }],
            },
          });
        } else if (block.type === "tool_use" && block.id && block.name) {
          const cls = classify(block.name);
          toolClass.set(block.id, cls);

          // Observability: mint a child span per tool call if the driver
          // provided a turnSpanId. The matching `tool_result` later closes
          // the same span_id. We also emit a `span.tool_call_start`
          // boundary event so waterfall reconstruction is a single scan.
          let toolSpanId: string | undefined;
          if (opts.turnSpanId) {
            toolSpanId = newId("span");
            toolSpan.set(block.id, toolSpanId);
            toolMeta.set(block.id, { name: block.name, startMs: Date.now() });
            out.push({
              type: "span.tool_call_start",
              payload: {
                tool_use_id: block.id,
                name: block.name,
                tool_class: cls,
              },
              spanId: toolSpanId,
              parentSpanId: opts.turnSpanId,
            });
          }

          if (cls === "custom") {
            sawCustom = true;
            out.push({
              type: "agent.custom_tool_use",
              payload: {
                tool_use_id: block.id,
                name: block.name,
                input: block.input ?? {},
              },
              ...(toolSpanId ? { spanId: toolSpanId, parentSpanId: opts.turnSpanId } : {}),
            });
          } else if (cls === "mcp") {
            // name format: mcp__server__tool
            const parts = block.name.split("__");
            const serverName = parts[1] ?? "unknown";
            const toolName = parts.slice(2).join("__") || block.name;
            out.push({
              type: "agent.mcp_tool_use",
              payload: {
                tool_use_id: block.id,
                server_name: serverName,
                tool_name: toolName,
                input: block.input ?? {},
              },
              ...(toolSpanId ? { spanId: toolSpanId, parentSpanId: opts.turnSpanId } : {}),
            });
          } else {
            out.push({
              type: "agent.tool_use",
              payload: {
                tool_use_id: block.id,
                name: block.name,
                input: block.input ?? {},
              },
              ...(toolSpanId ? { spanId: toolSpanId, parentSpanId: opts.turnSpanId } : {}),
            });
          }
        }
      }
      return out;
    }

    if (type === "user") {
      const msg = (raw.message as ClaudeMessage | undefined) ?? {};
      const blocks = msg.content ?? [];
      for (const block of blocks) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const cls = toolClass.get(block.tool_use_id);
          if (cls === "custom") continue; // custom tool results come from the client
          const eventType = cls === "mcp" ? "agent.mcp_tool_result" : "agent.tool_result";

          // Observability: if we minted a span for this tool_use, tag the
          // result with the same span id and emit a matching
          // `span.tool_call_end` boundary so the span has explicit close.
          const toolSpanId = toolSpan.get(block.tool_use_id);
          const meta = toolMeta.get(block.tool_use_id);

          out.push({
            type: eventType,
            payload: {
              tool_use_id: block.tool_use_id,
              content: block.content ?? null,
              is_error: block.is_error ?? false,
            },
            ...(toolSpanId ? { spanId: toolSpanId, parentSpanId: opts.turnSpanId } : {}),
          });

          if (toolSpanId && opts.turnSpanId) {
            const durationMs = meta ? Date.now() - meta.startMs : null;
            out.push({
              type: "span.tool_call_end",
              payload: {
                tool_use_id: block.tool_use_id,
                name: meta?.name ?? null,
                tool_class: cls ?? "builtin",
                status: block.is_error ? "error" : "ok",
                duration_ms: durationMs,
              },
              spanId: toolSpanId,
              parentSpanId: opts.turnSpanId,
            });
            toolSpan.delete(block.tool_use_id);
            toolMeta.delete(block.tool_use_id);
          }
        }
      }
      return out;
    }

    if (type === "result") {
      const subtype = String(raw.subtype ?? "success");
      const usageRaw = (raw.usage as ClaudeMessage["usage"] | undefined) ?? {};
      const usage: TurnUsage = {
        input_tokens: usageRaw.input_tokens ?? 0,
        output_tokens: usageRaw.output_tokens ?? 0,
        cache_read_input_tokens: usageRaw.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usageRaw.cache_creation_input_tokens ?? 0,
        cost_usd: (raw.total_cost_usd as number | undefined) ?? 0,
      };
      let stopReason: TurnResult["stopReason"];
      if (sawCustom) stopReason = "custom_tool_call";
      else if (subtype === "error_max_turns") stopReason = "max_turns";
      else if (subtype === "error_during_execution") stopReason = "error";
      else stopReason = "end_turn";

      turnResult = {
        stopReason,
        usage,
        num_turns: (raw.num_turns as number | undefined) ?? 1,
      };
      return out;
    }

    // Unrecognized — drop silently, translator is forward-compatible.
    return out;
  }

  return {
    translate,
    getBackendSessionId: () => claudeSessionId,
    getTurnResult: () => turnResult,
    sawCustomToolUse: () => sawCustom,
  };
}
