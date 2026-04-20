/**
 * Trace query handlers.
 *
 *   GET  /v1/traces/:trace_id   — full trace as event list + reassembled
 *                                 span tree; spans are paired at read time
 *                                 from the event log, no materialized
 *                                 storage.
 *   GET  /v1/traces              — recent traces (query param `session_id`
 *                                 narrows to one session; otherwise lists
 *                                 every distinct trace across the DB).
 *   POST /v1/traces/:trace_id/export
 *                                — trigger OTLP export for the trace,
 *                                 bypassing the auto-export hook.
 */
import { routeWrap, jsonOk } from "../http";
import { listEventsByTrace, rowToManagedEvent } from "../db/events";
import { listTraces } from "../db/traces";
import { exportTrace } from "../observability/otlp";
import { badRequest, notFound } from "../errors";
import type { EventRow } from "../types";

interface SpanNode {
  span_id: string;
  parent_span_id: string | null;
  session_id: string;
  name: string;
  start_ms: number;
  end_ms: number | null;
  duration_ms: number | null;
  status: "ok" | "error" | "interrupted" | "unclosed";
  attributes: Record<string, unknown>;
  children: SpanNode[];
}

/**
 * Pair span.*_start and span.*_end events into a tree of span nodes.
 * Unmatched starts produce `status: "unclosed"` nodes that end at the
 * trace's last event time.
 */
function buildSpanTree(events: EventRow[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>();
  const openStarts = new Map<string, EventRow>();

  const parsePayload = (r: EventRow): Record<string, unknown> => {
    try {
      return JSON.parse(r.payload_json) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const mkNode = (startRow: EventRow, startPayload: Record<string, unknown>): SpanNode => {
    const modelName = typeof startPayload.model === "string" ? startPayload.model : null;
    const toolName = typeof startPayload.name === "string" ? startPayload.name : null;
    let name: string;
    switch (startRow.type) {
      case "span.model_request_start":
        name = modelName ? `turn ${modelName}` : "turn";
        break;
      case "span.tool_call_start":
        name = toolName ? `tool ${toolName}` : "tool";
        break;
      case "span.outcome_evaluation_start":
        name = "outcome_evaluation";
        break;
      default:
        name = startRow.type;
    }
    return {
      span_id: startRow.span_id!,
      parent_span_id: startRow.parent_span_id,
      session_id: startRow.session_id,
      name,
      start_ms: startRow.received_at,
      end_ms: null,
      duration_ms: null,
      status: "unclosed",
      attributes: { ...startPayload },
      children: [],
    };
  };

  for (const e of events) {
    if (!e.span_id) continue;
    const payload = parsePayload(e);

    if (e.type.endsWith("_start")) {
      openStarts.set(e.span_id, e);
      nodes.set(e.span_id, mkNode(e, payload));
      continue;
    }
    if (e.type.endsWith("_end")) {
      const node = nodes.get(e.span_id);
      if (!node) continue; // dangling end, skip
      openStarts.delete(e.span_id);
      node.end_ms = e.received_at;
      node.duration_ms = Math.max(0, e.received_at - node.start_ms);
      const rawStatus = typeof payload.status === "string" ? payload.status : "ok";
      node.status =
        rawStatus === "ok" || rawStatus === "error" || rawStatus === "interrupted"
          ? (rawStatus as SpanNode["status"])
          : "ok";
      // Merge end-side payload for fuller attributes
      for (const [k, v] of Object.entries(payload)) {
        node.attributes[k] = v;
      }
    }
  }

  // Close any still-open spans at the trace's last event time
  if (openStarts.size > 0 && events.length > 0) {
    const lastMs = events[events.length - 1].received_at;
    for (const [spanId] of openStarts) {
      const node = nodes.get(spanId);
      if (node) {
        node.end_ms = lastMs;
        node.duration_ms = Math.max(0, lastMs - node.start_ms);
      }
    }
  }

  // Assemble the tree by linking children to parents. Orphan spans
  // (parent not in the trace) are promoted to roots.
  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    if (node.parent_span_id && nodes.has(node.parent_span_id)) {
      nodes.get(node.parent_span_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort siblings by start_ms for determinism
  const sortRec = (ns: SpanNode[]): void => {
    ns.sort((a, b) => a.start_ms - b.start_ms);
    for (const n of ns) sortRec(n.children);
  };
  sortRec(roots);

  return roots;
}

/**
 * Summary totals derived from the trace event log — sum of usage
 * deltas across all span.*_end events in the trace.
 */
interface TraceSummary {
  trace_id: string;
  span_count: number;
  session_ids: string[];
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  turn_count: number;
  tool_call_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
}

function summarizeTrace(traceId: string, events: EventRow[]): TraceSummary {
  let start = events.length > 0 ? events[0].received_at : 0;
  let end = events.length > 0 ? events[events.length - 1].received_at : 0;
  const sessionIds = new Set<string>();
  let turnCount = 0;
  let toolCallCount = 0;
  let errorCount = 0;
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_usd: 0,
  };
  const spanIds = new Set<string>();

  for (const e of events) {
    sessionIds.add(e.session_id);
    if (e.span_id) spanIds.add(e.span_id);
    if (e.received_at < start) start = e.received_at;
    if (e.received_at > end) end = e.received_at;
    if (e.type === "span.model_request_end") {
      turnCount++;
      try {
        const payload = JSON.parse(e.payload_json) as {
          status?: string;
          model_usage?: typeof usage | null;
        };
        if (payload.status && payload.status !== "ok") errorCount++;
        if (payload.model_usage) {
          usage.input_tokens += payload.model_usage.input_tokens ?? 0;
          usage.output_tokens += payload.model_usage.output_tokens ?? 0;
          usage.cache_read_input_tokens += payload.model_usage.cache_read_input_tokens ?? 0;
          usage.cache_creation_input_tokens += payload.model_usage.cache_creation_input_tokens ?? 0;
          usage.cost_usd += payload.model_usage.cost_usd ?? 0;
        }
      } catch {
        /* ignore malformed */
      }
    }
    if (e.type === "span.tool_call_start") toolCallCount++;
    if (e.type === "session.error") errorCount++;
  }

  return {
    trace_id: traceId,
    span_count: spanIds.size,
    session_ids: [...sessionIds],
    start_ms: start,
    end_ms: end,
    duration_ms: Math.max(0, end - start),
    turn_count: turnCount,
    tool_call_count: toolCallCount,
    error_count: errorCount,
    ...usage,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────

export function handleGetTrace(
  request: Request,
  traceId: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    if (!traceId || typeof traceId !== "string") {
      throw badRequest("trace_id required");
    }

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "2000");
    const events = listEventsByTrace(traceId, limit);
    if (events.length === 0) {
      throw notFound(`trace ${traceId} not found`);
    }

    const summary = summarizeTrace(traceId, events);
    const spanTree = buildSpanTree(events);

    return jsonOk({
      ...summary,
      spans: spanTree,
      events: events.map(rowToManagedEvent),
    });
  });
}

/**
 * List the most recent trace ids, optionally filtered by `session_id`
 * query param. Ordered newest-first by MAX(received_at) per trace.
 */
export function handleListTraces(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session_id") ?? undefined;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "20"), 1), 100);

    const rows = listTraces({ sessionId, limit });

    return jsonOk({
      data: rows.map((r) => ({
        trace_id: r.trace_id,
        start_ms: r.start_ms,
        end_ms: r.end_ms,
        duration_ms: Math.max(0, r.end_ms - r.start_ms),
        event_count: r.event_count,
        session_count: r.session_count,
        first_session_id: r.first_session_id,
      })),
    });
  });
}

/**
 * Manual OTLP export trigger. Fires synchronously (awaited) so the caller
 * can see the export status. Useful for debugging the auto-export hook.
 */
export function handleExportTrace(
  request: Request,
  traceId: string,
): Promise<Response> {
  return routeWrap(request, async () => {
    if (!traceId) throw badRequest("trace_id required");
    const result = await exportTrace(traceId);
    return jsonOk(result, result.ok ? 200 : 502);
  });
}
