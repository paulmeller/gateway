import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * Agent-level metrics (DB-backed) — cost, tokens, turns, tool calls,
 * stop-reason distribution, tool latency percentiles. Aggregated on-read
 * over the sessions + events tables.
 */
export interface AgentMetrics {
  window: { from: number; to: number };
  group_by: string;
  totals: {
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
  };
  groups: Array<{
    key: string;
    session_count: number;
    turn_count: number;
    tool_call_count: number;
    error_count: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>;
  stop_reasons: Record<string, number>;
  tool_latency_p50_ms: number | null;
  tool_latency_p95_ms: number | null;
  tool_latency_p99_ms: number | null;
  tool_call_sample_count: number;
}

export function useAgentMetrics(opts: { windowMs: number; groupBy?: string }) {
  const { windowMs, groupBy = "agent" } = opts;
  return useQuery({
    queryKey: ["metrics", "agent", windowMs, groupBy],
    queryFn: () => {
      const to = Date.now();
      const from = to - windowMs;
      return api<AgentMetrics>(
        `/metrics?group_by=${groupBy}&from=${from}&to=${to}`,
      );
    },
    refetchInterval: 15_000,
  });
}

/**
 * API-level metrics (in-memory ring buffer) — request rate, latency
 * percentiles, status-class distribution, per-route rollup, per-minute
 * timeline. Populated by the recorder on every routeWrap call.
 */
export interface ApiMetrics {
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
  routes: Array<{
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
  }>;
  timeline: Array<{
    minute_ms: number;
    count: number;
    rps: number;
    error_count: number;
  }>;
}

export function useApiMetrics(opts: { windowMinutes: number }) {
  const { windowMinutes } = opts;
  return useQuery({
    queryKey: ["metrics", "api", windowMinutes],
    queryFn: () =>
      api<ApiMetrics>(`/metrics/api?window_minutes=${windowMinutes}`),
    refetchInterval: 5_000,
  });
}
