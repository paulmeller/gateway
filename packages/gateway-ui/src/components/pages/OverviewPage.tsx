import { useState, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { Server, Zap, Plus, Play, Key, ArrowRight, Eye, EyeOff, Copy, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAgents } from "@/hooks/use-agents";
import { useSessions } from "@/hooks/use-sessions";
import { useEnvironments } from "@/hooks/use-environments";
import { useAgentMetrics, useApiMetrics } from "@/hooks/use-metrics";
import { StatTile, formatUsd } from "@/components/dashboard/StatTile";
import { Sparkline } from "@/components/dashboard/Sparkline";
import { WelcomeHero, WelcomeHeroSkeleton } from "./WelcomeHero";
import { toast } from "sonner";

function maskKey(key: string): string {
  if (key.length <= 10) return "••••••••";
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

function ApiKeyCard({ apiKey }: { apiKey: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!apiKey) return;
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    toast.success("API key copied");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card size="sm" className="mt-2">
      <CardContent>
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Key className="size-3.5" />
          API Key
        </div>
        {apiKey ? (
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 rounded bg-muted px-2 py-1.5 font-mono text-xs text-foreground break-all select-all">
              {revealed ? apiKey : maskKey(apiKey)}
            </code>
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title={revealed ? "Hide" : "Reveal"}
            >
              {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
            <button
              type="button"
              onClick={copy}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Copy"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No API key found</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(ts: number | string): string {
  const ms = typeof ts === "string" ? new Date(ts).getTime() : ts;
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function statusBadge(status: string) {
  if (status === "active" || status === "running") {
    return <Badge variant="outline" className="border-lime-400/20 bg-lime-400/10 text-lime-400 text-xs">{status}</Badge>;
  }
  if (status === "error" || status === "failed") {
    return <Badge variant="outline" className="border-red-400/20 bg-red-400/10 text-red-400 text-xs">{status}</Badge>;
  }
  return <Badge variant="outline" className="text-muted-foreground text-xs">{status}</Badge>;
}

// ─── OverviewPage ─────────────────────────────────────────────────────────────

const HERO_DISMISSED_KEY = "as.hero_dismissed";

// Fixed windows — Home is not tunable. Same keys as Analytics 15m selector
// so TanStack Query caches are shared.
const AGENT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const API_WINDOW_MIN = 60;              // 60 minutes (capped by recorder retention)

export function OverviewPage() {
  const agentsQ = useAgents();
  const sessionsQ = useSessions();
  const envsQ = useEnvironments();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(HERO_DISMISSED_KEY) === "1");

  // Sync dismissal when header's Skip button fires (via dispatched storage event)
  useEffect(() => {
    const handler = () => setDismissed(localStorage.getItem(HERO_DISMISSED_KEY) === "1");
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const agents = agentsQ.data;
  const sessions = sessionsQ.data;
  const environments = envsQ.data;

  const agentCount = agents?.length ?? 0;
  const envCount = environments?.length ?? 0;
  const totalSessions = sessions?.length ?? 0;
  const activeSessions = sessions?.filter((s) => s.status === "active" || s.status === "running").length ?? 0;

  const recentSessions = sessions?.slice(0, 20) ?? [];
  const apiKey = window.__MA_API_KEY__ ?? "";

  // Empty-state onboarding logic
  const allLoaded = !agentsQ.isPending && !sessionsQ.isPending && !envsQ.isPending;
  const anyError = agentsQ.isError || sessionsQ.isError || envsQ.isError;
  const isEmpty = allLoaded && !anyError && agentCount === 0 && envCount === 0 && totalSessions === 0;

  // Metrics for pulse row — only fetch after initial resource load (avoid wasted
  // calls during empty state and WelcomeHero)
  const shouldFetchMetrics = allLoaded && !isEmpty;
  const agentMetricsQ = useAgentMetrics({ windowMs: AGENT_WINDOW_MS, groupBy: "agent" });
  const apiMetricsQ = useApiMetrics({ windowMinutes: API_WINDOW_MIN });

  if (!allLoaded && !anyError) {
    return <WelcomeHeroSkeleton />;
  }

  if (isEmpty && !dismissed) {
    return <WelcomeHero apiKey={apiKey} />;
  }

  // ── Pulse metrics ──────────────────────────────────────────────────────────
  const agentTotals = agentMetricsQ.data?.totals;
  const apiTotals = apiMetricsQ.data?.totals;
  const metricsLoading = shouldFetchMetrics && (agentMetricsQ.isPending || apiMetricsQ.isPending);

  const turns15m = agentTotals?.turn_count ?? 0;
  const errors15m = agentTotals?.error_count ?? 0;
  const cost15m = agentTotals?.cost_usd ?? 0;
  const totalRequests15m = apiTotals?.count ?? 0;

  // Tone thresholds
  const errorsTone: "warn" | "danger" | "neutral" = errors15m > 5 ? "danger" : errors15m > 0 ? "warn" : "neutral";
  const activeTone: "accent" | "neutral" = activeSessions > 0 ? "accent" : "neutral";

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="grid grid-cols-3 gap-6 h-full">
        {/* Left column */}
        <div className="col-span-2 flex flex-col gap-6 min-h-0">
          {/* Pulse tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile
              label="Active"
              value={activeSessions}
              tone={activeTone}
              info="Sessions currently running a turn. Counts sessions whose status is active or running."
            />
            <StatTile
              label="Turns / 15m"
              value={turns15m}
              loading={metricsLoading}
              info="Agent turns completed in the last 15 minutes. A turn is one user-message → agent-response round (may include multiple tool calls)."
            />
            <StatTile
              label="Errors / 15m"
              value={errors15m}
              tone={errorsTone}
              loading={metricsLoading}
              info="Agent turns that ended in an error stop reason over the last 15 minutes (separate from API 5xx errors)."
            />
            <StatTile
              label="Cost / 15m"
              value={formatUsd(cost15m)}
              loading={metricsLoading}
              info="Estimated model cost accrued in the last 15 minutes, summed across all agents and sessions."
            />
          </div>

          {/* Requests sparkline */}
          <Link to="/dashboard" className="block group">
            <Card size="sm" className="transition-colors group-hover:ring-foreground/20">
              <CardContent>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Requests — last {API_WINDOW_MIN} min
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {totalRequests15m.toLocaleString()} total
                  </span>
                </div>
                <div className="mt-2">
                  <Sparkline
                    data={apiMetricsQ.data?.timeline.map(t => t.count) ?? []}
                    height={64}
                  />
                </div>
              </CardContent>
            </Card>
          </Link>

          {/* Recent Activity — fills remaining vertical space */}
          <Card className="flex-1 flex flex-col min-h-0">
            <CardHeader>
              <CardTitle>Recent Activity</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto min-h-0">
              {recentSessions.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Title</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentSessions.map((session) => {
                      const agentName =
                        agents?.find((a) => a.id === session.agent?.id)?.name ?? session.agent?.id?.slice(0, 8) ?? "—";
                      return (
                        <TableRow key={session.id}>
                          <TableCell>
                            <Link
                              to="/playground/$sessionId"
                              params={{ sessionId: session.id }}
                              className="text-foreground hover:underline font-medium"
                            >
                              {session.title ?? session.id.slice(0, 12) + "…"}
                            </Link>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{agentName}</TableCell>
                          <TableCell>{statusBadge(session.status)}</TableCell>
                          <TableCell className="text-muted-foreground">{timeAgo(session.created_at)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">No sessions yet.</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-foreground">Quick Actions</h2>

          <div className="flex flex-col gap-2">
            <Link to="/agents" className="flex items-center gap-3 rounded-xl p-3 text-sm font-medium text-foreground ring-1 ring-foreground/10 hover:bg-accent transition-colors">
              <span className="text-muted-foreground"><Plus className="size-4" /></span>
              Create Agent
            </Link>
            <Link to="/environments" className="flex items-center gap-3 rounded-xl p-3 text-sm font-medium text-foreground ring-1 ring-foreground/10 hover:bg-accent transition-colors">
              <span className="text-muted-foreground"><Server className="size-4" /></span>
              Add Environment
            </Link>
            <Link to="/playground" className="flex items-center gap-3 rounded-xl p-3 text-sm font-medium text-foreground ring-1 ring-foreground/10 hover:bg-accent transition-colors">
              <span className="text-muted-foreground"><Play className="size-4" /></span>
              Open Playground
            </Link>
            <Link to="/quickstart" className="flex items-center gap-3 rounded-xl p-3 text-sm font-medium text-foreground ring-1 ring-foreground/10 hover:bg-accent transition-colors">
              <span className="text-muted-foreground"><Zap className="size-4" /></span>
              Quick Start
            </Link>
          </div>

          {/* API Key display — masked by default, reveal + copy */}
          <ApiKeyCard apiKey={apiKey} />

          {/* System mini-card */}
          <Card size="sm">
            <CardContent>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">System</span>
                <Link to="/dashboard" className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5">
                  View analytics
                  <ArrowRight className="size-3" />
                </Link>
              </div>
              <div className="mt-2 flex flex-col gap-1 text-[11px] font-mono">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">requests</span>
                  <span className="text-foreground tabular-nums">{totalRequests15m.toLocaleString()} <span className="text-muted-foreground">(60m)</span></span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">errors</span>
                  <span className={`tabular-nums ${errors15m > 0 ? "text-amber-500" : "text-foreground"}`}>
                    {errors15m} <span className="text-muted-foreground">(15m)</span>
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">agents</span>
                  <span className="text-foreground tabular-nums">{agentCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">environments</span>
                  <span className="text-foreground tabular-nums">{envCount}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
