/**
 * Stateful translator: codex NDJSON → Managed Agents events.
 *
 * Ported from
 * 
 *
 * Codex's event model (emitted by `codex exec --json`):
 *   - `thread.started` — session init with `thread_id`
 *   - `item.completed` — work item finished; `item.type` determines the shape:
 *     - `agent_message` → text response → `agent.message`
 *     - `command_execution` → shell command + output → [tool_use, tool_result]
 *     - `mcp_tool_call` → MCP tool call + result → [tool_use, tool_result]
 *     - `file_change` → file edit/add/delete → tool_use
 *   - `turn.completed` — end of an internal reasoning turn; accumulates usage
 *   - `error` — stream-level error
 *
 * Key differences from opencode:
 *   - translate() can return ARRAYS of events (for command_execution and
 *     mcp_tool_call where we split the codex "completed item" into both a
 *     tool_use and a tool_result in our Managed Agents timeline)
 *   - No inline "result" event from codex — usage is accumulated across
 *     turn.completed events and the final TurnResult is synthesized by
 *     getTurnResult() when the stream ends. The driver calls this after the
 *     stream loop exits, which is equivalent to finalize()
 *     hook without requiring a new interface method.
 */
import type {
  ToolClass,
  TranslatedEvent,
  Translator,
  TranslatorOptions,
  TurnResult,
  TurnUsage,
} from "../shared/translator-types";

interface CodexItem {
  type?: string;
  id?: string;
  text?: string;
  command?: string;
  output?: string;
  result?: string;
  name?: string;
  input?: unknown;
  path?: string;
  action?: string;
}

export function createCodexTranslator(opts: TranslatorOptions): Translator {
  const toolClass = new Map<string, ToolClass>();
  let sessionId: string | null = null;
  let turnCount = 0;
  let lastText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let sawCustom = false;

  function classify(name: string): ToolClass {
    if (opts.customToolNames.has(name)) return "custom";
    return "builtin";
  }

  function translate(raw: Record<string, unknown>): TranslatedEvent[] {
    const out: TranslatedEvent[] = [];
    if (!raw || typeof raw !== "object") return out;
    const type = String(raw.type ?? "");

    if (type === "thread.started") {
      if (typeof raw.thread_id === "string") sessionId = raw.thread_id;
      // Driver emits session.status_running; translator just tracks state.
      return out;
    }

    if (type === "item.completed" && raw.item && typeof raw.item === "object") {
      const item = raw.item as CodexItem;

      if (item.type === "reasoning" && typeof item.text === "string") {
        out.push({
          type: "agent.thinking",
          payload: { content: [{ type: "thinking", thinking: item.text }] },
        });
        return out;
      }

      if (item.type === "agent_message" && typeof item.text === "string") {
        lastText = item.text;
        out.push({
          type: "agent.message",
          payload: { content: [{ type: "text", text: item.text }] },
        });
        return out;
      }

      if (item.type === "command_execution" && typeof item.id === "string") {
        const name = "command";
        const cls = classify(name);
        toolClass.set(item.id, cls);
        if (cls === "custom") sawCustom = true;
        const useType = cls === "custom" ? "agent.custom_tool_use" : "agent.tool_use";

        out.push({
          type: useType,
          payload: {
            tool_use_id: item.id,
            name,
            input: { command: item.command ?? "" },
          },
        });
        if (cls !== "custom") {
          out.push({
            type: "agent.tool_result",
            payload: {
              tool_use_id: item.id,
              content: item.output ?? item.result ?? "",
              is_error: false,
            },
          });
        }
        return out;
      }

      if (item.type === "mcp_tool_call" && typeof item.id === "string") {
        const name = item.name ?? "mcp_tool";
        const cls = classify(name);
        toolClass.set(item.id, cls);
        if (cls === "custom") sawCustom = true;
        const useType = cls === "custom" ? "agent.custom_tool_use" : "agent.tool_use";

        out.push({
          type: useType,
          payload: {
            tool_use_id: item.id,
            name,
            input: item.input ?? {},
          },
        });
        if (cls !== "custom") {
          out.push({
            type: "agent.tool_result",
            payload: {
              tool_use_id: item.id,
              content: item.output ?? "",
              is_error: false,
            },
          });
        }
        return out;
      }

      if (item.type === "file_change" && typeof item.id === "string") {
        const name = "file_edit";
        const cls = classify(name);
        toolClass.set(item.id, cls);
        if (cls === "custom") sawCustom = true;
        const useType = cls === "custom" ? "agent.custom_tool_use" : "agent.tool_use";
        out.push({
          type: useType,
          payload: {
            tool_use_id: item.id,
            name,
            input: { path: item.path ?? "", action: item.action ?? "edit" },
          },
        });
        return out;
      }
    }

    if (type === "turn.completed") {
      turnCount++;
      const usage = raw.usage as Record<string, unknown> | undefined;
      if (usage) {
        if (typeof usage.input_tokens === "number") {
          totalInputTokens += usage.input_tokens;
        }
        if (typeof usage.output_tokens === "number") {
          totalOutputTokens += usage.output_tokens;
        }
        if (typeof usage.cost_usd === "number") {
          totalCostUsd += usage.cost_usd;
        }
        // Defensive:  treats usage as Record<string, number>
        // and sums all keys generically. We extract the specific fields we
        // care about. Unknown keys are silently dropped.
      }
      return out;
    }

    if (type === "error") {
      const msg = (typeof raw.message === "string" ? raw.message : null)
        || ((raw.error as Record<string, unknown>)?.message as string)
        || "Unknown codex error";
      out.push({
        type: "session.error" as const,
        payload: { error: { type: "backend_error", message: msg } },
      });
      return out;
    }

    if (type === "turn.failed") {
      const err = raw.error as Record<string, unknown> | undefined;
      const msg = (err?.message as string) || "Turn failed";
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
    // Codex doesn't emit a sentinel "finished" event — turn.completed
    // accumulates and the stream just closes. The driver calls this after
    // the stream loop exits, which is the equivalent of '
    // finalize() hook.
    if (turnCount === 0 && !lastText) return null;
    return {
      stopReason: sawCustom ? "custom_tool_call" : "end_turn",
      usage: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cost_usd: totalCostUsd,
      },
      num_turns: turnCount || 1,
    };
  }

  return {
    translate,
    getBackendSessionId: () => sessionId,
    getTurnResult,
    sawCustomToolUse: () => sawCustom,
  };
}
