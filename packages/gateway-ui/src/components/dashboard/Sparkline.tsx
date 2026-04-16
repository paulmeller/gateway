/**
 * Tiny inline SVG chart primitives for the dashboard.
 *
 * We deliberately don't pull in recharts / chart.js / d3 — the dashboard
 * only needs sparklines and bar lists, the single-file HTML bundle is
 * already heavy, and shadcn/ui's chart recipes would add ~80KB gzipped.
 * Two component exports:
 *
 *   - <Sparkline data={numbers} height={40} /> — area chart with stroke
 *   - <BarList data={{label, value}[]} /> — horizontal bars with totals
 */

interface SparklineProps {
  data: number[];
  height?: number;
  className?: string;
  /** Optional parallel error-count series rendered as a red overlay. */
  errors?: number[];
}

export function Sparkline({ data, height = 48, className, errors }: SparklineProps) {
  if (data.length === 0) {
    return (
      <div
        className={`flex items-center justify-center text-xs text-muted-foreground/40 ${className ?? ""}`}
        style={{ height }}
      >
        no data
      </div>
    );
  }

  const width = 400;
  const max = Math.max(...data, 1);
  const stepX = width / Math.max(data.length - 1, 1);

  // Build area path
  const linePoints = data
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - (v / max) * (height - 4) - 2).toFixed(1)}`)
    .join(" ");
  const areaPath = `M 0,${height} L ${linePoints} L ${width},${height} Z`;

  // Error overlay
  const errorBars =
    errors?.map((e, i) => {
      if (e === 0) return null;
      const x = i * stepX;
      const barHeight = Math.max(2, (e / max) * (height - 4));
      return (
        <rect
          key={i}
          x={x - 1}
          y={height - barHeight}
          width={2}
          height={barHeight}
          fill="currentColor"
          className="text-destructive/70"
        />
      );
    }) ?? null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`w-full text-foreground ${className ?? ""}`}
      style={{ height }}
    >
      <path d={areaPath} className="fill-primary/10" />
      <polyline
        points={linePoints}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-primary"
      />
      {errorBars}
    </svg>
  );
}

interface BarListItem {
  label: string;
  value: number;
  subtitle?: string;
  color?: string;
}

interface BarListProps {
  data: BarListItem[];
  /** Max rows to show. Extras collapse to a `+N more` line. */
  limit?: number;
  formatValue?: (n: number) => string;
}

export function BarList({ data, limit = 8, formatValue = (n) => n.toLocaleString() }: BarListProps) {
  if (data.length === 0) {
    return <p className="text-xs text-muted-foreground/50 italic">no data</p>;
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const shown = data.slice(0, limit);
  const overflow = data.length - shown.length;

  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((d) => {
        const pct = (d.value / max) * 100;
        return (
          <div key={d.label} className="relative flex items-center text-xs">
            <div
              className={`absolute inset-y-0 left-0 rounded-sm ${d.color ?? "bg-primary/10"}`}
              style={{ width: `${pct}%` }}
            />
            <div className="relative z-10 flex w-full items-center justify-between gap-2 px-2 py-1">
              <span className="truncate font-mono text-[11px] text-foreground">{d.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatValue(d.value)}
                {d.subtitle && (
                  <span className="ml-1.5 text-muted-foreground/60">{d.subtitle}</span>
                )}
              </span>
            </div>
          </div>
        );
      })}
      {overflow > 0 && (
        <p className="text-[11px] text-muted-foreground/50 px-2">+ {overflow} more</p>
      )}
    </div>
  );
}
