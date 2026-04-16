/**
 * StatTile — shared stat card used by Home pulse bar and Analytics page.
 *
 * Tones:
 *   neutral — default foreground
 *   warn    — amber (for thresholds exceeded: errors, slow latency)
 *   danger  — red  (for critical thresholds)
 *   accent  — lime (for positive "live" signals like active sessions)
 */
import { Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type StatTileTone = "neutral" | "warn" | "danger" | "accent";

export function StatTile({
  label,
  value,
  loading,
  tone = "neutral",
  info,
}: {
  label: string;
  value: number | string;
  loading?: boolean;
  tone?: StatTileTone;
  /** Optional description shown in a tooltip on an info icon next to the label. */
  info?: string;
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
    <Card size="sm" className="h-full">
      <CardContent className="flex h-full flex-col">
        <div className="flex items-center gap-1">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          {info && (
            <Tooltip>
              <TooltipTrigger
                render={(props) => (
                  <button
                    {...props}
                    type="button"
                    aria-label={`About ${label}`}
                    className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                  />
                )}
              >
                <Info className="size-3" />
              </TooltipTrigger>
              <TooltipContent>{info}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <p
          className={`mt-auto pt-1 font-mono text-lg tabular-nums ${toneClass} ${
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
