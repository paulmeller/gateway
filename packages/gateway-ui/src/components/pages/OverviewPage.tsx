import { Link } from "@tanstack/react-router";
import { Bot, Server, MessageSquare, Zap, Plus, Play, Key } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useAgents } from "@/hooks/use-agents";
import { useSessions } from "@/hooks/use-sessions";
import { useEnvironments } from "@/hooks/use-environments";

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
    return (
      <Badge variant="outline" className="border-lime-400/20 bg-lime-400/10 text-lime-400 text-xs">
        {status}
      </Badge>
    );
  }
  if (status === "error" || status === "failed") {
    return (
      <Badge variant="outline" className="border-red-400/20 bg-red-400/10 text-red-400 text-xs">
        {status}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground text-xs">
      {status}
    </Badge>
  );
}

// ─── Stat Card ───────────────────────────────────────────────────────────────

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
}

function StatCard({ icon, label, value }: StatCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-3xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

// ─── Quick Action Card ────────────────────────────────────────────────────────

interface QuickActionCardProps {
  to: string;
  icon: React.ReactNode;
  label: string;
}

function QuickActionCard({ to, icon, label }: QuickActionCardProps) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm font-medium text-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </Link>
  );
}

// ─── OverviewPage ─────────────────────────────────────────────────────────────

export function OverviewPage() {
  const { data: agents } = useAgents();
  const { data: sessions } = useSessions();
  const { data: environments } = useEnvironments();

  const agentCount = agents?.length ?? 0;
  const envCount = environments?.length ?? 0;
  const totalSessions = sessions?.length ?? 0;
  const activeSessions = sessions?.filter((s) => s.status === "active" || s.status === "running").length ?? 0;

  const recentSessions = sessions?.slice(0, 10) ?? [];

  const apiKey = window.__MA_API_KEY__ ?? "";

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="grid grid-cols-3 gap-6">
        {/* Left column */}
        <div className="col-span-2 flex flex-col gap-6">
          {/* Stats bar */}
          <div className="grid grid-cols-4 gap-4">
            <StatCard
              icon={<Bot className="size-4" />}
              label="Agents"
              value={agentCount}
            />
            <StatCard
              icon={<Server className="size-4" />}
              label="Environments"
              value={envCount}
            />
            <StatCard
              icon={<Zap className="size-4" />}
              label="Active Sessions"
              value={activeSessions}
            />
            <StatCard
              icon={<MessageSquare className="size-4" />}
              label="Total Sessions"
              value={totalSessions}
            />
          </div>

          {/* Recent Activity */}
          <div className="rounded-lg border border-border">
            <div className="px-4 py-3 border-b border-border">
              <h2 className="text-sm font-semibold text-foreground">Recent Activity</h2>
            </div>
            {recentSessions.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs">
                    <th className="px-4 py-2 text-left font-medium">Title</th>
                    <th className="px-4 py-2 text-left font-medium">Agent</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-left font-medium">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSessions.map((session) => {
                    const agentName =
                      agents?.find((a) => a.id === session.agent?.id)?.name ?? session.agent?.id?.slice(0, 8) ?? "—";
                    return (
                      <tr key={session.id} className="border-b border-border last:border-0 hover:bg-accent/30 transition-colors">
                        <td className="px-4 py-2.5">
                          <Link
                            to="/sessions/$id"
                            params={{ id: session.id }}
                            className="text-foreground hover:underline font-medium"
                          >
                            {session.title ?? session.id.slice(0, 12) + "…"}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{agentName}</td>
                        <td className="px-4 py-2.5">{statusBadge(session.status)}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{timeAgo(session.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">No sessions yet.</p>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-foreground">Quick Actions</h2>

          <div className="flex flex-col gap-2">
            <QuickActionCard to="/agents" icon={<Plus className="size-4" />} label="Create Agent" />
            <QuickActionCard to="/environments" icon={<Server className="size-4" />} label="Add Environment" />
            <QuickActionCard to="/playground" icon={<Play className="size-4" />} label="Open Playground" />
            <QuickActionCard to="/quickstart" icon={<Zap className="size-4" />} label="Quick Start" />
          </div>

          {/* API Key display */}
          <div className="mt-2 rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Key className="size-3.5" />
              API Key
            </div>
            {apiKey ? (
              <code className="block rounded bg-muted px-2 py-1.5 font-mono text-xs text-foreground break-all select-all">
                {apiKey}
              </code>
            ) : (
              <p className="text-xs text-muted-foreground">No API key found</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
