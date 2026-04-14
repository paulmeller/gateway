/**
 * Observability metrics handler.
 *
 *   GET /v1/metrics?group_by=agent|environment|backend|hour|day
 *                   &from=<ms>&to=<ms>
 *                   &agent_id=...&environment_id=...
 *
 * On-read aggregation over the sessions + events tables. No materialized
 * rollup tables (cut from the plan per the architect review). Queries
 * use covering indexes on `(type, received_at)` and `sessions.created_at`
 * which SQLite WAL handles fine at this tool's scale.
 *
 * Response shape:
 *
 *   {
 *     totals: { turn_count, tool_call_count, error_count, input_tokens,
 *               output_tokens, cost_usd, ... },
 *     groups: [
 *       { key: "agent_foo", turn_count, ... },
 *       ...
 *     ],
 *     stop_reasons: { end_turn: 42, error: 3, interrupted: 1, ... },
 *     tool_latency_p50_ms: 1280,
 *     tool_latency_p95_ms: 4810
 *   }
 */
import { routeWrap, jsonOk } from "../http";
import { getDb } from "../db/client";
import { badRequest } from "../errors";

type GroupBy = "agent" | "environment" | "backend" | "hour" | "day" | "none";

interface Totals {
  session_count: number;
  turn_count: number;
  tool_call_count: number;
  error_count: number;
  active_seconds: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
}

interface GroupRow extends Totals {
  key: string;
}

function zeroTotals(): Totals {
  return {
    session_count: 0,
    turn_count: 0,
    tool_call_count: 0,
    error_count: 0,
    active_seconds: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_usd: 0,
  };
}

function parseGroupBy(raw: string | null): GroupBy {
  if (!raw) return "none";
  if (raw === "agent" || raw === "environment" || raw === "backend" || raw === "hour" || raw === "day") {
    return raw;
  }
  return "none";
}

function groupByExpr(g: GroupBy): string {
  switch (g) {
    case "agent":
      return "s.agent_id";
    case "environment":
      return "s.environment_id";
    case "backend":
      return "av.backend";
    case "hour":
      // SQLite strftime returns UTC bucket keys like '2026-04-14 15'
      return "strftime('%Y-%m-%dT%H:00', s.created_at/1000, 'unixepoch')";
    case "day":
      return "strftime('%Y-%m-%d', s.created_at/1000, 'unixepoch')";
    default:
      return "'all'";
  }
}

export function handleGetMetrics(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const url = new URL(request.url);
    const group = parseGroupBy(url.searchParams.get("group_by"));
    const from = Number(url.searchParams.get("from") ?? "0");
    const to = Number(url.searchParams.get("to") ?? `${Date.now()}`);
    const agentId = url.searchParams.get("agent_id");
    const environmentId = url.searchParams.get("environment_id");

    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) {
      throw badRequest("from/to must be non-negative integers (ms since epoch)");
    }
    if (from > to) {
      throw badRequest("from must be <= to");
    }

    const db = getDb();
    const groupExpr = groupByExpr(group);

    // ── Aggregate sessions table — totals + group rollup ───────────────────
    const params: unknown[] = [from, to];
    let filter = "s.created_at >= ? AND s.created_at <= ?";
    if (agentId) {
      filter += " AND s.agent_id = ?";
      params.push(agentId);
    }
    if (environmentId) {
      filter += " AND s.environment_id = ?";
      params.push(environmentId);
    }

    interface GroupSql extends Totals {
      key: string;
    }
    const groupRows = db
      .prepare(
        `SELECT ${groupExpr}                                AS key,
                COUNT(*)                                    AS session_count,
                COALESCE(SUM(s.turn_count), 0)              AS turn_count,
                COALESCE(SUM(s.tool_calls_count), 0)        AS tool_call_count,
                COALESCE(SUM(s.active_seconds), 0)          AS active_seconds,
                COALESCE(SUM(s.usage_input_tokens), 0)      AS input_tokens,
                COALESCE(SUM(s.usage_output_tokens), 0)     AS output_tokens,
                COALESCE(SUM(s.usage_cache_read_input_tokens), 0)     AS cache_read_input_tokens,
                COALESCE(SUM(s.usage_cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
                COALESCE(SUM(s.usage_cost_usd), 0)          AS cost_usd,
                0                                           AS error_count
         FROM sessions s
         JOIN agent_versions av
           ON av.agent_id = s.agent_id AND av.version = s.agent_version
         WHERE ${filter}
         GROUP BY ${groupExpr}
         ORDER BY turn_count DESC`,
      )
      .all(...params) as GroupSql[];

    // ── Error count — from events table ────────────────────────────────────
    // sessions table doesn't track error count separately, so count
    // session.error events in the same window.
    const errorFilterParams: unknown[] = [from, to];
    let errorFilter =
      "e.type = 'session.error' AND e.received_at >= ? AND e.received_at <= ?";
    if (agentId) {
      errorFilter += " AND s.agent_id = ?";
      errorFilterParams.push(agentId);
    }
    if (environmentId) {
      errorFilter += " AND s.environment_id = ?";
      errorFilterParams.push(environmentId);
    }
    const errorRows = db
      .prepare(
        `SELECT ${groupExpr} AS key, COUNT(*) AS error_count
         FROM events e
         JOIN sessions s        ON s.id = e.session_id
         JOIN agent_versions av ON av.agent_id = s.agent_id AND av.version = s.agent_version
         WHERE ${errorFilter}
         GROUP BY ${groupExpr}`,
      )
      .all(...errorFilterParams) as Array<{ key: string; error_count: number }>;

    const errorsByKey = new Map(errorRows.map((r) => [r.key, r.error_count]));
    for (const row of groupRows) {
      row.error_count = errorsByKey.get(row.key) ?? 0;
    }

    // ── Stop-reason distribution ───────────────────────────────────────────
    // CAREFUL: `sessions.stop_reason` is an existing column, so `GROUP BY
    // stop_reason` (using our SELECT alias) resolves to the table column,
    // not the json_extract expression. Use the expression directly.
    const stopRows = db
      .prepare(
        `SELECT json_extract(e.payload_json, '$.stop_reason') AS stop_reason_value,
                COUNT(*) AS count
         FROM events e
         JOIN sessions s ON s.id = e.session_id
         WHERE e.type = 'session.status_idle'
           AND e.received_at BETWEEN ? AND ?
           ${agentId ? "AND s.agent_id = ?" : ""}
           ${environmentId ? "AND s.environment_id = ?" : ""}
         GROUP BY json_extract(e.payload_json, '$.stop_reason')`,
      )
      .all(
        ...[from, to, ...(agentId ? [agentId] : []), ...(environmentId ? [environmentId] : [])],
      ) as Array<{ stop_reason_value: string | null; count: number }>;

    const stopReasons: Record<string, number> = {};
    for (const r of stopRows) {
      stopReasons[r.stop_reason_value ?? "unknown"] = r.count;
    }

    // ── Tool-call duration percentiles ─────────────────────────────────────
    const toolDurationRows = db
      .prepare(
        `SELECT CAST(json_extract(e.payload_json, '$.duration_ms') AS REAL) AS d
         FROM events e
         JOIN sessions s ON s.id = e.session_id
         WHERE e.type = 'span.tool_call_end'
           AND e.received_at BETWEEN ? AND ?
           ${agentId ? "AND s.agent_id = ?" : ""}
           ${environmentId ? "AND s.environment_id = ?" : ""}
           AND json_extract(e.payload_json, '$.duration_ms') IS NOT NULL
         ORDER BY d ASC`,
      )
      .all(
        ...[from, to, ...(agentId ? [agentId] : []), ...(environmentId ? [environmentId] : [])],
      ) as Array<{ d: number }>;

    const durations = toolDurationRows.map((r) => r.d).filter((d) => Number.isFinite(d));
    const pct = (p: number): number | null => {
      if (durations.length === 0) return null;
      const idx = Math.min(durations.length - 1, Math.floor((p / 100) * durations.length));
      return durations[idx];
    };

    // ── Totals ─────────────────────────────────────────────────────────────
    const totals = zeroTotals();
    for (const row of groupRows) {
      totals.session_count += row.session_count;
      totals.turn_count += row.turn_count;
      totals.tool_call_count += row.tool_call_count;
      totals.error_count += row.error_count;
      totals.active_seconds += row.active_seconds;
      totals.input_tokens += row.input_tokens;
      totals.output_tokens += row.output_tokens;
      totals.cache_read_input_tokens += row.cache_read_input_tokens;
      totals.cache_creation_input_tokens += row.cache_creation_input_tokens;
      totals.cost_usd += row.cost_usd;
    }

    return jsonOk({
      window: { from, to },
      group_by: group,
      totals,
      groups: group === "none" ? [] : (groupRows as GroupRow[]),
      stop_reasons: stopReasons,
      tool_latency_p50_ms: pct(50),
      tool_latency_p95_ms: pct(95),
      tool_latency_p99_ms: pct(99),
      tool_call_sample_count: durations.length,
    });
  });
}
