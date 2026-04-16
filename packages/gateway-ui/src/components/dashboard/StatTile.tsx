/**
 * StatTile — shared stat card used by Home pulse bar and Analytics page.
 *
 * Tones:
 *   neutral — default foreground
 *   warn    — amber (for thresholds exceeded: errors, slow latency)
 *   danger  — red  (for critical thresholds)
 *   accent  — lime (for positive "live" signals like active sessions)
 */
import { Card, CardContent } from "@/components/ui/card";

export type StatTileTone = "neutral" | "warn" | "danger" | "accent";

export function StatTile({
  label,
  value,
  loading,
  tone = "neutral",
}: {
  label: string;
  value: number | string;
  loading?: boolean;
  tone?: StatTileTone;
}) {
  // Only apply tone when value is non-zero (zeros are always muted)
  const isZero = value === 0 || value === "0" || value === "—";
  let toneClass = "text-foreground";
  if (!isZero) {
    if (tone === "warn") toneClass = "text-amber-500";
    else if (tone === "danger") toneClass = "text-red-500";
    else if (tone === "accent") toneClass = "text-lime-400";
  }

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

export function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
