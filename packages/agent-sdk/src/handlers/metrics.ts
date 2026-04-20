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
import { getDb } from "../db/client"; // raw SQL holdout: 4 queries use dynamic GROUP BY expressions and runtime-built SQL fragments that cannot be expressed as Drizzle sql`` templates without sql.raw() on every identifier — kept as-is for safety and readability.
import { badRequest } from "../errors";
import { snapshotApiMetrics } from "../observability/api-metrics";
import { requireGlobalAdmin, tenantFilter } from "../auth/scope";
import { requireFeature } from "../license";

type GroupBy = "agent" | "environment" | "backend" | "hour" | "day" | "api_key" | "none";

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
  if (
    raw === "agent" || raw === "environment" || raw === "backend" ||
    raw === "hour" || raw === "day" || raw === "api_key"
  ) {
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
    case "api_key":
      // Null (pre-0.4 sessions) collapses to "__unattributed__" bucket.
      return "COALESCE(s.api_key_id, '__unattributed__')";
    case "hour":
      // SQLite strftime returns UTC bucket keys like '2026-04-14 15'
      return "strftime('%Y-%m-%dT%H:00', s.created_at/1000, 'unixepoch')";
    case "day":
      return "strftime('%Y-%m-%d', s.created_at/1000, 'unixepoch')";
    default:
      return "'all'";
  }
}

// ── Time-series (PR2.5) ──────────────────────────────────────────────────

type TimeBucket = "hour" | "day" | "week";

function parseTimeBucket(raw: string | null): TimeBucket | null {
  if (raw === "hour" || raw === "day" || raw === "week") return raw;
  return null;
}

function bucketStrftime(b: TimeBucket): string {
  switch (b) {
    case "hour": return "%Y-%m-%dT%H:00";
    case "day":  return "%Y-%m-%d";
    case "week": return "%Y-%W";
  }
}

const BUCKET_MS: Record<TimeBucket, number> = {
  hour: 60 * 60 * 1000,
  day:  24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

const TOP_N = 10;
const MAX_POINTS_PER_SERIES = 200;
const MAX_TOTAL_CELLS = 2000;

interface Point {
  t: string;
  cost_usd: number;
  session_count: number;
  turn_count: number;
  error_count: number;
}

function zeroPoint(t: string): Point {
  return { t, cost_usd: 0, session_count: 0, turn_count: 0, error_count: 0 };
}

/**
 * Handle the `group_by=api_key&time_bucket=...` case.
 *
 * SQL bucketing via strftime. Top-N keys by cost get their own series;
 * other keys collapse into "__other__"; legacy sessions (api_key_id NULL)
 * collapse into "__unattributed__". Missing buckets are zero-filled so
 * chart clients don't have to. Hard caps on combinations to keep the
 * response bounded.
 */
function handleKeyTimeSeries(
  db: ReturnType<typeof getDb>,
  from: number,
  to: number,
  bucket: TimeBucket,
  tenantId: string | null,
): Response {
  // Validate combinations — reject the obviously-bad ones with a 400 that
  // names the next-larger bucket instead of silently returning garbage.
  const windowMs = to - from;
  const pointsInWindow = Math.ceil(windowMs / BUCKET_MS[bucket]);
  if (pointsInWindow > MAX_POINTS_PER_SERIES) {
    const next: Record<TimeBucket, string> = { hour: "day", day: "week", week: "week" };
    throw badRequest(
      `time_bucket=${bucket} produces ${pointsInWindow} points for a ${Math.round(windowMs / (24*60*60*1000))}d window ` +
      `(max ${MAX_POINTS_PER_SERIES}). Use time_bucket=${next[bucket]}.`,
    );
  }
  const maxCells = (TOP_N + 2) * pointsInWindow; // +2 for __other__ and __unattributed__
  if (maxCells > MAX_TOTAL_CELLS) {
    throw badRequest(
      `combination exceeds the ${MAX_TOTAL_CELLS} cell cap (${maxCells} possible). Narrow window or use a larger bucket.`,
    );
  }

  const strftime = bucketStrftime(bucket);

  // Tenant scoping — append a clause and extra param when the caller
  // isn't a global admin. Tenant users only see their own tenant's costs.
  const tenantClause = tenantId != null ? " AND tenant_id = ?" : "";
  const tenantClauseJoin = tenantId != null ? " AND s.tenant_id = ?" : "";
  const tenantArgs: unknown[] = tenantId != null ? [tenantId] : [];

  // Pick top-N keys by total cost in the window. Keys outside top-N
  // rewrite to "__other__" before pivot; NULLs rewrite to "__unattributed__".
  const topRows = db
    .prepare(
      `SELECT api_key_id AS key, SUM(usage_cost_usd) AS cost
         FROM sessions
        WHERE created_at BETWEEN ? AND ?
          AND api_key_id IS NOT NULL${tenantClause}
        GROUP BY api_key_id
        ORDER BY cost DESC
        LIMIT ?`,
    )
    .all(from, to, ...tenantArgs, TOP_N) as Array<{ key: string; cost: number }>;
  const topKeys = new Set(topRows.map(r => r.key));
  const classifyKey = (raw: string | null): string => {
    if (raw == null) return "__unattributed__";
    if (topKeys.has(raw)) return raw;
    return "__other__";
  };

  // Bucket aggregate across sessions.
  const raw = db
    .prepare(
      `SELECT strftime(?, s.created_at/1000, 'unixepoch') AS t,
              s.api_key_id AS key,
              COUNT(*)                                AS session_count,
              COALESCE(SUM(s.usage_cost_usd), 0)      AS cost_usd,
              COALESCE(SUM(s.turn_count), 0)          AS turn_count
         FROM sessions s
        WHERE s.created_at BETWEEN ? AND ?${tenantClauseJoin}
        GROUP BY t, s.api_key_id`,
    )
    .all(strftime, from, to, ...tenantArgs) as Array<{
      t: string;
      key: string | null;
      session_count: number;
      cost_usd: number;
      turn_count: number;
    }>;

  // Bucket aggregate for error counts via events table (separate query;
  // merged in JS on (t, key)). Collapses by session's api_key_id.
  const errorRaw = db
    .prepare(
      `SELECT strftime(?, e.received_at/1000, 'unixepoch') AS t,
              s.api_key_id AS key,
              COUNT(*) AS error_count
         FROM events e
         JOIN sessions s ON s.id = e.session_id
        WHERE e.type = 'session.error'
          AND e.received_at BETWEEN ? AND ?${tenantClauseJoin}
        GROUP BY t, s.api_key_id`,
    )
    .all(strftime, from, to, ...tenantArgs) as Array<{
      t: string;
      key: string | null;
      error_count: number;
    }>;

  // Build the full set of bucket labels in the window so we can zero-fill.
  // Use Date iteration; hours/days straightforward, weeks via stepping 7 days.
  const labels: string[] = [];
  const step = BUCKET_MS[bucket];
  const format = (ms: number): string => {
    const d = new Date(ms);
    if (bucket === "hour") return d.toISOString().slice(0, 13) + ":00";
    if (bucket === "day")  return d.toISOString().slice(0, 10);
    // week: rough strftime('%Y-%W'). Node doesn't have ISO week built-in,
    // approximate by: year-weekNumber where weekNumber = floor((dayOfYear - 1)/7)+1.
    // This matches SQLite's %W closely enough for a chart axis label.
    const year = d.getUTCFullYear();
    const start = Date.UTC(year, 0, 1);
    const week = Math.floor((ms - start) / (7 * 24 * 3600 * 1000));
    return `${year}-${String(week).padStart(2, "0")}`;
  };
  // Align "from" to the bucket start. For hour/day, Date already buckets;
  // for week we just step — a bit rough at boundaries but chart axis tolerates it.
  for (let t = from; t <= to; t += step) {
    const label = format(t);
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length === 0) labels.push(format(from));

  // Pivot into per-key series.
  type SeriesMap = Map<string, Map<string, Point>>;
  const seriesByKey: SeriesMap = new Map();
  const touchSeries = (keyClass: string): Map<string, Point> => {
    let m = seriesByKey.get(keyClass);
    if (!m) {
      m = new Map();
      for (const lbl of labels) m.set(lbl, zeroPoint(lbl));
      seriesByKey.set(keyClass, m);
    }
    return m;
  };
  for (const row of raw) {
    const cls = classifyKey(row.key);
    const series = touchSeries(cls);
    const p = series.get(row.t) ?? zeroPoint(row.t);
    p.cost_usd += row.cost_usd;
    p.session_count += row.session_count;
    p.turn_count += row.turn_count;
    series.set(row.t, p);
  }
  for (const row of errorRaw) {
    const cls = classifyKey(row.key);
    const series = touchSeries(cls);
    const p = series.get(row.t) ?? zeroPoint(row.t);
    p.error_count += row.error_count;
    series.set(row.t, p);
  }

  // Load names for the top keys so the chart can label them. Also
  // tenant-scope the api_keys lookup so a tenant user can't resolve
  // another tenant's key name.
  const keyMeta = new Map<string, string>();
  if (topKeys.size > 0) {
    const placeholders = Array.from(topKeys).map(() => "?").join(",");
    const tenantWhere = tenantId != null ? " AND tenant_id = ?" : "";
    const rows = db
      .prepare(`SELECT id, name FROM api_keys WHERE id IN (${placeholders})${tenantWhere}`)
      .all(...topKeys, ...tenantArgs) as Array<{ id: string; name: string }>;
    for (const r of rows) keyMeta.set(r.id, r.name);
  }

  // Aggregate totals across all keys/buckets.
  const totals = zeroTotals();
  for (const series of seriesByKey.values()) {
    for (const p of series.values()) {
      totals.cost_usd += p.cost_usd;
      totals.session_count += p.session_count;
      totals.turn_count += p.turn_count;
      totals.error_count += p.error_count;
    }
  }

  const series = Array.from(seriesByKey.entries()).map(([key, pts]) => ({
    key,
    name: keyMeta.get(key) ?? (key.startsWith("__") ? key.replace(/^__|__$/g, "") : key),
    points: labels.map(lbl => pts.get(lbl) ?? zeroPoint(lbl)),
  }));

  return jsonOk({
    window: { from, to },
    group_by: "api_key",
    time_bucket: bucket,
    totals,
    series,
  });
}

export function handleGetMetrics(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const url = new URL(request.url);
    const group = parseGroupBy(url.searchParams.get("group_by"));
    const from = Number(url.searchParams.get("from") ?? "0");
    const to = Number(url.searchParams.get("to") ?? `${Date.now()}`);
    const agentId = url.searchParams.get("agent_id");
    const environmentId = url.searchParams.get("environment_id");
    const timeBucket = parseTimeBucket(url.searchParams.get("time_bucket"));
    const tenantId = tenantFilter(auth);

    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) {
      throw badRequest("from/to must be non-negative integers (ms since epoch)");
    }
    if (from > to) {
      throw badRequest("from must be <= to");
    }

    const db = getDb();

    // Time-series fast-path: group_by=api_key + time_bucket returns the
    // series form. Other combos fall through to the existing aggregation.
    // Per-key analytics are an enterprise feature.
    if (group === "api_key") {
      requireFeature("per_key_analytics", "per-key analytics");
    }
    if (group === "api_key" && timeBucket) {
      return handleKeyTimeSeries(db, from, to, timeBucket, tenantId);
    }

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
    if (tenantId != null) {
      filter += " AND s.tenant_id = ?";
      params.push(tenantId);
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
    if (tenantId != null) {
      errorFilter += " AND s.tenant_id = ?";
      errorFilterParams.push(tenantId);
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
    // stop_reason is now an object { type: "..." } in the event payload.
    // Use COALESCE to handle both new (object) and legacy (string) formats.
    const stopRows = db
      .prepare(
        `SELECT COALESCE(
                  json_extract(e.payload_json, '$.stop_reason.type'),
                  json_extract(e.payload_json, '$.stop_reason')
                ) AS stop_reason_value,
                COUNT(*) AS count
         FROM events e
         JOIN sessions s ON s.id = e.session_id
         WHERE e.type = 'session.status_idle'
           AND e.received_at BETWEEN ? AND ?
           ${agentId ? "AND s.agent_id = ?" : ""}
           ${environmentId ? "AND s.environment_id = ?" : ""}
           ${tenantId != null ? "AND s.tenant_id = ?" : ""}
         GROUP BY COALESCE(
                    json_extract(e.payload_json, '$.stop_reason.type'),
                    json_extract(e.payload_json, '$.stop_reason')
                  )`,
      )
      .all(
        ...[
          from, to,
          ...(agentId ? [agentId] : []),
          ...(environmentId ? [environmentId] : []),
          ...(tenantId != null ? [tenantId] : []),
        ],
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
           ${tenantId != null ? "AND s.tenant_id = ?" : ""}
           AND json_extract(e.payload_json, '$.duration_ms') IS NOT NULL
         ORDER BY d ASC`,
      )
      .all(
        ...[
          from, to,
          ...(agentId ? [agentId] : []),
          ...(environmentId ? [environmentId] : []),
          ...(tenantId != null ? [tenantId] : []),
        ],
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

/**
 * API throughput / latency snapshot for the dashboard.
 *
 * Unlike `handleGetMetrics` which aggregates the DB, this handler reads
 * the in-process ring buffer populated by `routeWrap`. The ring buffer
 * is NOT tenant-partitioned — it counts every request, so the snapshot
 * leaks cross-tenant traffic patterns (throughput, 5xx rate, route
 * cardinality). Global-admin-only for that reason.
 *
 * Query params:
 *   - `window_minutes`  — rolling window (1..60, default 60)
 */
export function handleGetApiMetrics(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireGlobalAdmin(auth);
    const url = new URL(request.url);
    const wmRaw = Number(url.searchParams.get("window_minutes") ?? "60");
    if (!Number.isFinite(wmRaw) || wmRaw <= 0) {
      throw badRequest("window_minutes must be a positive integer");
    }
    const windowMinutes = Math.min(Math.max(Math.floor(wmRaw), 1), 60);
    return jsonOk(snapshotApiMetrics({ windowMs: windowMinutes * 60_000 }));
  });
}
