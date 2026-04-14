/**
 * Multi-agent thread orchestrator.
 *
 * When a parent session's agent calls `spawn_agent`, the driver delegates
 * to this module. It creates a child session, runs it to completion, and
 * returns the child's final agent.message text as the tool result.
 *
 * Depth is capped at MAX_THREAD_DEPTH to prevent infinite recursion.
 */
import { createSession, getSessionRow, bumpSessionStats } from "../db/sessions";
import { getAgent } from "../db/agents";
import { getSession } from "../db/sessions";
import { listEvents } from "../db/events";
import { appendEvent } from "./bus";
import { getActor } from "./actor";
import { runTurn } from "./driver";
import type { TraceContext } from "./trace";
import { nowMs } from "../util/clock";
import { ApiError } from "../errors";

const MAX_THREAD_DEPTH = 3;

/**
 * Spawn a child agent session, run it to completion, and return the
 * child's final agent.message text.
 *
 * `parentTrace` (when provided) propagates the parent turn's trace id and
 * current span id into the child's `runTurn`, so events emitted by the
 * child session share the same trace and render as nested spans in the
 * cross-session waterfall.
 */
export async function handleSpawnAgent(
  parentSessionId: string,
  agentId: string,
  prompt: string,
  parentDepth: number,
  parentTrace?: TraceContext,
): Promise<string> {
  if (parentDepth >= MAX_THREAD_DEPTH) {
    throw new ApiError(
      400,
      "invalid_request_error",
      `thread depth limit reached (max ${MAX_THREAD_DEPTH})`,
    );
  }

  const parentSession = getSession(parentSessionId);
  if (!parentSession) {
    throw new ApiError(404, "not_found_error", `parent session not found: ${parentSessionId}`);
  }

  const agent = getAgent(agentId);
  if (!agent) {
    throw new ApiError(404, "not_found_error", `agent not found: ${agentId}`);
  }

  // Create child session with parent reference and incremented depth
  const childSession = createSession({
    agent_id: agent.id,
    agent_version: agent.version,
    environment_id: parentSession.environment_id,
    title: `Thread from ${parentSessionId}`,
    metadata: { parent_session_id: parentSessionId },
    parent_session_id: parentSessionId,
    thread_depth: parentDepth + 1,
    vault_ids: parentSession.vault_ids,
  });

  // Emit thread_started on parent — tagged with the parent turn's trace
  // context so it threads into the waterfall under the spawning span.
  appendEvent(parentSessionId, {
    type: "session.thread_started",
    payload: { child_session_id: childSession.id, agent_id: agentId },
    origin: "server",
    processedAt: nowMs(),
    traceId: parentTrace?.trace_id ?? null,
    spanId: parentTrace?.span_id ?? null,
    parentSpanId: parentTrace?.parent_span_id ?? null,
  });

  // Spawn the child actor
  getActor(childSession.id);

  // Run the child turn. Pass the parent's trace context so the child's
  // runTurn mints a span nested under the parent's current span — the
  // whole cross-session fan-out renders as one trace tree.
  const eventId = `thread_${childSession.id}_${nowMs()}`;
  await runTurn(childSession.id, [
    { kind: "text", eventId, text: prompt },
  ], 0, parentTrace);

  // Wait for completion: poll until session is idle
  const maxWaitMs = 300_000; // 5 minutes
  const pollIntervalMs = 500;
  const startMs = nowMs();
  let childRow = getSessionRow(childSession.id);
  while (childRow && childRow.status === "running" && nowMs() - startMs < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    childRow = getSessionRow(childSession.id);
  }

  // If timed out, interrupt and clean up the child
  if (childRow && childRow.status === "running") {
    const { interruptSession } = await import("./interrupt");
    interruptSession(childSession.id);
  }

  // Extract the last agent.message text from the child's events
  let resultText = "";
  const events = listEvents(childSession.id, { limit: 100, order: "desc" });
  for (const evt of events) {
    if (evt.type === "agent.message") {
      const payload = JSON.parse(evt.payload_json) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (payload.content ?? [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("");
      if (text) {
        resultText = text;
        break;
      }
    }
  }

  // Sub-agent cost rollup (the architect's #1 omission).
  //
  // Read the child's usage deltas and apply them to the parent session.
  // Without this, multi-agent runs show zero cost on the parent row and
  // users can't tell how much a single user turn actually cost when it
  // fanned out across sub-agents. We roll up usage + tool-call count,
  // but NOT turn_count (keep parent turns separate from child turns).
  const finalChildRow = getSessionRow(childSession.id);
  if (finalChildRow) {
    bumpSessionStats(
      parentSessionId,
      { tool_calls_count: finalChildRow.tool_calls_count },
      {
        input_tokens: finalChildRow.usage_input_tokens,
        output_tokens: finalChildRow.usage_output_tokens,
        cache_read_input_tokens: finalChildRow.usage_cache_read_input_tokens,
        cache_creation_input_tokens: finalChildRow.usage_cache_creation_input_tokens,
        cost_usd: finalChildRow.usage_cost_usd,
      },
    );
  }

  // Emit thread_completed on parent — same trace tagging as thread_started.
  // Include the rolled-up child usage so dashboards can see the cost of
  // each spawn at a glance without having to join sessions.
  appendEvent(parentSessionId, {
    type: "session.thread_completed",
    payload: {
      child_session_id: childSession.id,
      result: resultText || "(no response from sub-agent)",
      child_usage: finalChildRow
        ? {
            input_tokens: finalChildRow.usage_input_tokens,
            output_tokens: finalChildRow.usage_output_tokens,
            cache_read_input_tokens: finalChildRow.usage_cache_read_input_tokens,
            cache_creation_input_tokens: finalChildRow.usage_cache_creation_input_tokens,
            cost_usd: finalChildRow.usage_cost_usd,
            tool_calls_count: finalChildRow.tool_calls_count,
          }
        : null,
    },
    origin: "server",
    processedAt: nowMs(),
    traceId: parentTrace?.trace_id ?? null,
    spanId: parentTrace?.span_id ?? null,
    parentSpanId: parentTrace?.parent_span_id ?? null,
  });

  return resultText || "(no response from sub-agent)";
}
