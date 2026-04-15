/**
 * In-process API request metrics recorder.
 *
 * Every HTTP request that flows through `routeWrap` records its route,
 * latency, and status code into a bounded ring buffer. The `/v1/metrics/api`
 * handler serves a snapshot of this buffer for the dashboard.
 *
 * ## Why in-memory
 *
 * API throughput is a high-cardinality, high-frequency signal. Persisting
 * every request to the events table would double the write load on the
 * hot path and blow up the DB. Keeping a rolling 60-minute window in
 * memory is enough for a live dashboard and costs ~50KB per process.
 * Restart resets the buffer; that's acceptable for throughput monitoring.
 *
 * ## Bucketing
 *
 *   - Time buckets: one per wall-clock minute, keyed by
 *     `Math.floor(now/60_000)`. 60 buckets retained = last hour.
 *
 *   - Route buckets: the request URL is normalized into a template by
 *     collapsing id-shaped path segments (ULID, hex, numeric) into `:id`.
 *     So `/v1/sessions/sess_01HXXX/events` becomes
 *     `/v1/sessions/:id/events`. Without normalization every request
 *     would create a new route key.
 *
 *   - Per (minute, route) we track: count, status-class counts
 *     (2xx/3xx/4xx/5xx), and a bounded latency sample (cap 500) from
 *     which p50/p95/p99 are computed on read.
 *
 * ## Exposed API
 *
 *   - `recordApiRequest(route, latencyMs, status)` — called once per
 *     request after the handler runs.
 *   - `snapshotApiMetrics({ windowMs })` — returns an aggregated view:
 *     totals, per-route rollup, per-minute time series.
 */

const MINUTE_MS = 60_000;
const MAX_MINUTES = 60;
const MAX_LATENCY_SAMPLES_PER_BUCKET = 500;

interface Bucket {
  count: number;
  status_2xx: number;
  status_3xx: number;
  status_4xx: number;
  status_5xx: number;
  /** Bounded sample for percentile estimation. FIFO-evicted past cap. */
  latencies: number[];
  /** Sum of latencies for mean calculation (not capped). */
  latency_sum: number;
}

function newBucket(): Bucket {
  return {
    count: 0,
    status_2xx: 0,
    status_3xx: 0,
    status_4xx: 0,
    status_5xx: 0,
    latencies: [],
    latency_sum: 0,
  };
}

/**
 * Storage: `Map<minuteKey, Map<route, Bucket>>`. Keyed this way so
 * pruning old minutes is O(1) per minute boundary and route rollup is
 * a single linear scan.
 */
type MinuteKey = number;
const store = new Map<MinuteKey, Map<string, Bucket>>();

function currentMinute(): MinuteKey {
  return Math.floor(Date.now() / MINUTE_MS);
}

function pruneOldMinutes(now: MinuteKey): void {
  const cutoff = now - MAX_MINUTES;
  for (const key of store.keys()) {
    if (key < cutoff) store.delete(key);
  }
}

/**
 * Collapse id-shaped path segments into `:id`. Recognized shapes:
 *
 *   - ULID-style prefixed ids: `sess_01HXXX...`, `agent_01HXXX`, `evt_01HXXX`
 *   - Bare ULIDs (26 crockford base32 chars)
 *   - Numeric segments
 *   - Hex segments >= 16 chars
 *
 * Query string is stripped before matching.
 */
export function normalizeRoute(url: string): string {
  // Pull the pathname out — accepts full URLs or bare paths
  let path: string;
  try {
    path = new URL(url, "http://x").pathname;
  } catch {
    path = url.split("?")[0];
  }

  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    // Prefixed id like `sess_01HXXX`
    if (/^[a-z]+_[0-9A-HJKMNP-TV-Z]{20,}$/i.test(p)) {
      parts[i] = ":id";
      continue;
    }
    // Bare ULID
    if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(p)) {
      parts[i] = ":id";
      continue;
    }
    // Numeric
    if (/^\d+$/.test(p) && p.length >= 2) {
      parts[i] = ":id";
      continue;
    }
    // Long hex
    if (/^[0-9a-f]{16,}$/i.test(p)) {
      parts[i] = ":id";
      continue;
    }
  }
  return parts.join("/") || "/";
}

/**
 * Record one request. Safe to call from any hot path — O(1) amortized,
 * no allocations past the bounded latency sample array.
 */
export function recordApiRequest(
  route: string,
  latencyMs: number,
  status: number,
): void {
  const now = currentMinute();

  // Lazily prune every ~1/100 calls to keep the map bounded
  if (Math.random() < 0.01) pruneOldMinutes(now);

  let minute = store.get(now);
  if (!minute) {
    minute = new Map();
    store.set(now, minute);
  }

  let bucket = minute.get(route);
  if (!bucket) {
    bucket = newBucket();
    minute.set(route, bucket);
  }

  bucket.count++;
  bucket.latency_sum += latencyMs;

  if (bucket.latencies.length < MAX_LATENCY_SAMPLES_PER_BUCKET) {
    bucket.latencies.push(latencyMs);
  } else {
    // Reservoir-style: replace a random existing sample so the
    // distribution stays representative even past the cap.
    const idx = Math.floor(Math.random() * MAX_LATENCY_SAMPLES_PER_BUCKET);
    bucket.latencies[idx] = latencyMs;
  }

  if (status >= 500) bucket.status_5xx++;
  else if (status >= 400) bucket.status_4xx++;
  else if (status >= 300) bucket.status_3xx++;
  else if (status >= 200) bucket.status_2xx++;
}

// ─────────────────────────────────────────────────────────────────────────
// Snapshot API
// ─────────────────────────────────────────────────────────────────────────

export interface RouteSnapshot {
  route: string;
  count: number;
  rps: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  mean_ms: number | null;
  status_2xx: number;
  status_3xx: number;
  status_4xx: number;
  status_5xx: number;
  error_rate: number;
}

export interface MinuteSnapshot {
  minute_ms: number;
  count: number;
  rps: number;
  error_count: number;
}

export interface ApiMetricsSnapshot {
  window_ms: number;
  window_minutes: number;
  now_ms: number;
  totals: {
    count: number;
    rps: number;
    p50_ms: number | null;
    p95_ms: number | null;
    p99_ms: number | null;
    status_2xx: number;
    status_3xx: number;
    status_4xx: number;
    status_5xx: number;
    error_rate: number;
  };
  routes: RouteSnapshot[];
  timeline: MinuteSnapshot[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Build a rolling snapshot over the last `windowMs` milliseconds.
 * Defaults to the full retained window (60 minutes).
 */
export function snapshotApiMetrics(
  opts: { windowMs?: number } = {},
): ApiMetricsSnapshot {
  const windowMs = opts.windowMs ?? MAX_MINUTES * MINUTE_MS;
  const windowMinutes = Math.ceil(windowMs / MINUTE_MS);
  const now = currentMinute();
  const from = now - windowMinutes + 1;
  pruneOldMinutes(now);

  // Aggregate per-route totals + per-minute timeline over the window.
  const routeAgg = new Map<string, Bucket>();
  const timeline: MinuteSnapshot[] = [];

  for (let k = from; k <= now; k++) {
    const minute = store.get(k);
    let minuteCount = 0;
    let minuteErrors = 0;
    if (minute) {
      for (const [route, bucket] of minute) {
        let agg = routeAgg.get(route);
        if (!agg) {
          agg = newBucket();
          routeAgg.set(route, agg);
        }
        agg.count += bucket.count;
        agg.latency_sum += bucket.latency_sum;
        agg.status_2xx += bucket.status_2xx;
        agg.status_3xx += bucket.status_3xx;
        agg.status_4xx += bucket.status_4xx;
        agg.status_5xx += bucket.status_5xx;
        // Latency samples: concatenate then cap (still bounded because
        // per-bucket cap is 500 and we at most have 60 buckets per route
        // in the window, so worst case ~30k — good enough).
        for (const l of bucket.latencies) {
          if (agg.latencies.length < 30_000) agg.latencies.push(l);
        }
        minuteCount += bucket.count;
        minuteErrors += bucket.status_4xx + bucket.status_5xx;
      }
    }
    timeline.push({
      minute_ms: k * MINUTE_MS,
      count: minuteCount,
      rps: minuteCount / 60,
      error_count: minuteErrors,
    });
  }

  // Per-route rollup with percentiles
  const routes: RouteSnapshot[] = [];
  let totalCount = 0;
  let total2xx = 0;
  let total3xx = 0;
  let total4xx = 0;
  let total5xx = 0;
  const allLatencies: number[] = [];

  for (const [route, agg] of routeAgg) {
    const sorted = [...agg.latencies].sort((a, b) => a - b);
    const mean = agg.count > 0 ? agg.latency_sum / agg.count : null;
    const errors = agg.status_4xx + agg.status_5xx;
    routes.push({
      route,
      count: agg.count,
      rps: agg.count / (windowMinutes * 60),
      p50_ms: percentile(sorted, 50),
      p95_ms: percentile(sorted, 95),
      p99_ms: percentile(sorted, 99),
      mean_ms: mean,
      status_2xx: agg.status_2xx,
      status_3xx: agg.status_3xx,
      status_4xx: agg.status_4xx,
      status_5xx: agg.status_5xx,
      error_rate: agg.count > 0 ? errors / agg.count : 0,
    });
    totalCount += agg.count;
    total2xx += agg.status_2xx;
    total3xx += agg.status_3xx;
    total4xx += agg.status_4xx;
    total5xx += agg.status_5xx;
    for (const l of agg.latencies) {
      if (allLatencies.length < 30_000) allLatencies.push(l);
    }
  }
  routes.sort((a, b) => b.count - a.count);

  const totalSorted = allLatencies.sort((a, b) => a - b);
  const totalErrors = total4xx + total5xx;

  return {
    window_ms: windowMs,
    window_minutes: windowMinutes,
    now_ms: Date.now(),
    totals: {
      count: totalCount,
      rps: totalCount / (windowMinutes * 60),
      p50_ms: percentile(totalSorted, 50),
      p95_ms: percentile(totalSorted, 95),
      p99_ms: percentile(totalSorted, 99),
      status_2xx: total2xx,
      status_3xx: total3xx,
      status_4xx: total4xx,
      status_5xx: total5xx,
      error_rate: totalCount > 0 ? totalErrors / totalCount : 0,
    },
    routes,
    timeline,
  };
}

/** Clears the recorder. Exposed for tests. */
export function resetApiMetrics(): void {
  store.clear();
}
