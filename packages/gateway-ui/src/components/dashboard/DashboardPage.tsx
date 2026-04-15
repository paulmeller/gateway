/**
 * Observability dashboard page.
 *
 * Two sources feed the dashboard:
 *
 *   1. /v1/metrics       — DB-aggregated agent metrics (cost, tokens,
 *                          turns, tool calls, stop reasons, tool
 *                          latency percentiles)
 *   2. /v1/metrics/api   — In-memory API throughput recorder
 *                          (request rate, status classes, p50/p95/p99
 *                          latency, per-route rollup, per-minute
 *                          timeline)
 *
 * The agent-metrics query refreshes every 15s, the API-metrics query
 * every 5s — matches the different data freshness needs. The component
 * itself doesn't do any aggregation; everything is computed server-side.
 *
 * Design notes: charts are inline SVG (see Sparkline.tsx) so we don't
 * pull in a charting library. Layout is a 2-column grid with tiles for
 * each metric class.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppStore } from "@/stores/app-store";
import { useAgentMetrics, useApiMetrics } from "@/hooks/use-metrics";
import { Sparkline, BarList } from "./Sparkline";

const WINDOWS = [
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "6 hours", minutes: 6 * 60 },
  { label: "24 hours", minutes: 24 * 60 },
];

export function DashboardPage() {
  const windowMinutes = useAppStore((s) => s.dashboardWindowMinutes);
  const setWindowMinutes = useAppStore((s) => s.setDashboardWindowMinutes);

  // Clamp API window to the recorder's 60-minute retention. Agent metrics
  // honor the user's selection directly.
  const apiWindow = Math.min(windowMinutes, 60);

  const agentQuery = useAgentMetrics({
    windowMs: windowMinutes * 60_000,
    groupBy: "agent",
  });
  const apiQuery = useApiMetrics({ windowMinutes: apiWindow });

  return (
    <div className="px-6 py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Analytics</h1>
          <p className="text-sm text-muted-foreground">Monitor agent activity and API performance.</p>
        </div>
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w.minutes}
              variant={windowMinutes === w.minutes ? "default" : "ghost"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setWindowMinutes(w.minutes)}
            >
              {w.label}
            </Button>
          ))}
        </div>
      </div>

      <div>
          {/* ── Agent metrics row ── */}
          <section className="mb-8">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Agent activity
            </h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile
                label="Sessions"
                value={agentQuery.data?.totals.session_count ?? 0}
                loading={agentQuery.isLoading}
              />
              <StatTile
                label="Turns"
                value={agentQuery.data?.totals.turn_count ?? 0}
                loading={agentQuery.isLoading}
              />
              <StatTile
                label="Tool calls"
                value={agentQuery.data?.totals.tool_call_count ?? 0}
                loading={agentQuery.isLoading}
              />
              <StatTile
                label="Errors"
                value={agentQuery.data?.totals.error_count ?? 0}
                loading={agentQuery.isLoading}
                tone={
                  agentQuery.data && agentQuery.data.totals.error_count > 0
                    ? "warn"
                    : "neutral"
                }
              />
              <StatTile
                label="Cost"
                value={formatUsd(agentQuery.data?.totals.cost_usd ?? 0)}
                loading={agentQuery.isLoading}
              />
              <StatTile
                label="Input tokens"
                value={agentQuery.data?.totals.input_tokens ?? 0}
                loading={agentQuery.isLoading}
              />
              <StatTile
                label="Output tokens"
                value={agentQuery.data?.totals.output_tokens ?? 0}
                loading={agentQuery.isLoading}
              />
              <StatTile
                label="Cache read"
                value={agentQuery.data?.totals.cache_read_input_tokens ?? 0}
                loading={agentQuery.isLoading}
              />
            </div>
          </section>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Stop reasons</CardTitle>
              </CardHeader>
              <CardContent>
                <BarList
                  data={
                    agentQuery.data
                      ? Object.entries(agentQuery.data.stop_reasons).map(
                          ([key, value]) => ({
                            label: key,
                            value,
                            color: stopReasonColor(key),
                          }),
                        )
                      : []
                  }
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Cost by agent</CardTitle>
              </CardHeader>
              <CardContent>
                <BarList
                  data={
                    agentQuery.data?.groups
                      .filter((g) => g.cost_usd > 0)
                      .map((g) => ({
                        label: g.key,
                        value: g.cost_usd,
                        subtitle: `${g.turn_count}t`,
                      })) ?? []
                  }
                  formatValue={formatUsd}
                />
              </CardContent>
            </Card>

            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm">
                  Tool-call latency
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    (p50/p95/p99 over {agentQuery.data?.tool_call_sample_count ?? 0} samples)
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4">
                  <LatencyStat
                    label="p50"
                    value={agentQuery.data?.tool_latency_p50_ms ?? null}
                  />
                  <LatencyStat
                    label="p95"
                    value={agentQuery.data?.tool_latency_p95_ms ?? null}
                  />
                  <LatencyStat
                    label="p99"
                    value={agentQuery.data?.tool_latency_p99_ms ?? null}
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── API throughput row ── */}
          <section className="mt-8">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                API throughput
              </h3>
              <span className="text-xs text-muted-foreground/60">
                last {apiWindow} min · in-process
              </span>
            </div>

            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatTile
                label="Requests"
                value={apiQuery.data?.totals.count ?? 0}
                loading={apiQuery.isLoading}
              />
              <StatTile
                label="Req / sec"
                value={(apiQuery.data?.totals.rps ?? 0).toFixed(2)}
                loading={apiQuery.isLoading}
              />
              <StatTile
                label="p50"
                value={
                  apiQuery.data?.totals.p50_ms != null
                    ? `${Math.round(apiQuery.data.totals.p50_ms)} ms`
                    : "—"
                }
                loading={apiQuery.isLoading}
              />
              <StatTile
                label="p95"
                value={
                  apiQuery.data?.totals.p95_ms != null
                    ? `${Math.round(apiQuery.data.totals.p95_ms)} ms`
                    : "—"
                }
                loading={apiQuery.isLoading}
              />
              <StatTile
                label="Error rate"
                value={`${((apiQuery.data?.totals.error_rate ?? 0) * 100).toFixed(1)}%`}
                loading={apiQuery.isLoading}
                tone={
                  apiQuery.data && apiQuery.data.totals.error_rate > 0.01
                    ? "warn"
                    : "neutral"
                }
              />
            </div>

            <Card className="mb-4">
              <CardHeader>
                <CardTitle className="text-sm">Requests per minute</CardTitle>
              </CardHeader>
              <CardContent>
                <Sparkline
                  data={apiQuery.data?.timeline.map((t) => t.count) ?? []}
                  errors={apiQuery.data?.timeline.map((t) => t.error_count) ?? []}
                  height={96}
                />
                <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{formatTimeAxis(apiQuery.data?.timeline[0]?.minute_ms)}</span>
                  <span>now</span>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">By route</CardTitle>
                </CardHeader>
                <CardContent>
                  <BarList
                    data={
                      apiQuery.data?.routes.map((r) => ({
                        label: r.route,
                        value: r.count,
                        subtitle:
                          r.p95_ms != null
                            ? `p95 ${Math.round(r.p95_ms)}ms`
                            : undefined,
                      })) ?? []
                    }
                    limit={10}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Status classes</CardTitle>
                </CardHeader>
                <CardContent>
                  <BarList
                    data={
                      apiQuery.data
                        ? [
                            {
                              label: "2xx",
                              value: apiQuery.data.totals.status_2xx,
                              color: "bg-emerald-500/15",
                            },
                            {
                              label: "3xx",
                              value: apiQuery.data.totals.status_3xx,
                              color: "bg-sky-500/15",
                            },
                            {
                              label: "4xx",
                              value: apiQuery.data.totals.status_4xx,
                              color: "bg-amber-500/15",
                            },
                            {
                              label: "5xx",
                              value: apiQuery.data.totals.status_5xx,
                              color: "bg-red-500/15",
                            },
                          ].filter((d) => d.value > 0)
                        : []
                    }
                  />
                </CardContent>
              </Card>
            </div>
          </section>
        </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Tiles + helpers
// ─────────────────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  loading,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  loading?: boolean;
  tone?: "neutral" | "warn";
}) {
  const toneClass =
    tone === "warn" && value !== 0 && value !== "0"
      ? "text-amber-500"
      : "text-foreground";
  return (
    <Card size="sm">
      <CardContent>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p
          className={`mt-1 font-mono text-lg tabular-nums ${toneClass} ${
            loading ? "opacity-40" : ""
          }`}
        >
          {typeof value === "number" ? value.toLocaleString() : value}
        </p>
      </CardContent>
    </Card>
  );
}

function LatencyStat({ label, value }: { label: string; value: number | null }) {
  return (
    <Card size="sm">
      <CardContent className="text-center">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 font-mono text-2xl tabular-nums text-foreground">
          {value != null ? `${Math.round(value)}` : "—"}
          {value != null && (
            <span className="ml-1 text-sm font-normal text-muted-foreground">ms</span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function stopReasonColor(key: string): string {
  switch (key) {
    case "end_turn":
      return "bg-emerald-500/15";
    case "error":
      return "bg-red-500/15";
    case "interrupted":
      return "bg-amber-500/15";
    case "custom_tool_call":
      return "bg-sky-500/15";
    default:
      return "bg-primary/10";
  }
}

function formatTimeAxis(ms: number | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
