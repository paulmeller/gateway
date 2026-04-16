/**
 * Per-key cost line chart (PR2.5). Renders the top-N keys over time.
 *
 * Data source: GET /v1/metrics?group_by=api_key&time_bucket=day|hour|week
 * Shape: { series: [{ key, name, points: [{t, cost_usd, ...}] }] }
 *
 * Fails closed: if the user's key isn't admin the request 403s, we show
 * nothing. Small dataset (≤10 series × 200 points) so recharts handles
 * it without any virtualization.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { api } from "@/lib/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface Point {
  t: string;
  cost_usd: number;
  session_count: number;
  turn_count: number;
  error_count: number;
}

interface Series {
  key: string;
  name: string;
  points: Point[];
}

interface Response {
  window: { from: number; to: number };
  group_by: "api_key";
  time_bucket: "hour" | "day" | "week";
  totals: { cost_usd: number; session_count: number };
  series: Series[];
}

// Deterministic color from key id for stable chart line colors across renders.
function colorForKey(key: string): string {
  if (key === "__other__") return "#64748b";
  if (key === "__unattributed__") return "#94a3b8";
  // Simple hash → HSL with high saturation, medium lightness.
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return `hsl(${h}, 65%, 55%)`;
}

type Bucket = "hour" | "day" | "week";
type WindowKey = "24h" | "7d" | "30d";

const WINDOWS: Record<WindowKey, { label: string; ms: number; defaultBucket: Bucket }> = {
  "24h": { label: "24 hours", ms: 24 * 60 * 60 * 1000, defaultBucket: "hour" },
  "7d":  { label: "7 days",   ms: 7 * 24 * 60 * 60 * 1000, defaultBucket: "day" },
  "30d": { label: "30 days",  ms: 30 * 24 * 60 * 60 * 1000, defaultBucket: "day" },
};

interface PivotRow {
  t: string;
  [keyId: string]: number | string;
}

/**
 * Pivot `series[].points[]` into a flat `[{t, key1: cost, key2: cost, ...}]`
 * so recharts can render one `<Line>` per key with a shared x-axis.
 */
function pivot(series: Series[]): PivotRow[] {
  const labels = new Set<string>();
  for (const s of series) for (const p of s.points) labels.add(p.t);
  const sortedLabels = Array.from(labels).sort();
  return sortedLabels.map(t => {
    const row: PivotRow = { t };
    for (const s of series) {
      const p = s.points.find(pp => pp.t === t);
      row[s.key] = p ? p.cost_usd : 0;
    }
    return row;
  });
}

export function KeyCostOverTime() {
  const [windowKey, setWindowKey] = useState<WindowKey>("7d");
  const { ms, defaultBucket } = WINDOWS[windowKey];

  const { data, isError, error, isPending } = useQuery({
    queryKey: ["metrics", "api_key", windowKey],
    queryFn: async () => {
      const now = Date.now();
      const params = new URLSearchParams({
        group_by: "api_key",
        time_bucket: defaultBucket,
        from: String(now - ms),
        to: String(now),
      });
      return api<Response>(`/metrics?${params}`);
    },
    refetchInterval: 30_000,
  });

  // Hide the chart for non-admins (no metrics access).
  if (isError && /403|forbidden|admin/i.test(String(error))) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Cost by API key</CardTitle>
          <div className="flex items-center gap-1">
            {(Object.keys(WINDOWS) as WindowKey[]).map(w => (
              <Button
                key={w}
                variant={windowKey === w ? "default" : "ghost"}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setWindowKey(w)}
              >
                {WINDOWS[w].label}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="h-64 flex items-center justify-center text-xs text-muted-foreground">Loading…</div>
        ) : !data || data.series.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-xs text-muted-foreground">
            No data yet — create a session with a virtual key to see per-key cost here.
          </div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={pivot(data.series)} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `$${v.toFixed(2)}`} />
                <Tooltip
                  formatter={((v: unknown, name: unknown) => {
                    const s = data.series.find(ss => ss.key === String(name));
                    return [`$${Number(v).toFixed(4)}`, s?.name ?? String(name)] as [string, string];
                  }) as never}
                  labelClassName="text-xs"
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: 11 }}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} formatter={((v: unknown) => data.series.find(s => s.key === String(v))?.name ?? String(v)) as never} />
                {data.series.map(s => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    stroke={colorForKey(s.key)}
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
