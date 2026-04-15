import { Link } from "@tanstack/react-router";
import { Server, Zap, Plus, Play, Key } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
    return <Badge variant="outline" className="border-lime-400/20 bg-lime-400/10 text-lime-400 text-xs">{status}</Badge>;
  }
  if (status === "error" || status === "failed") {
    return <Badge variant="outline" className="border-red-400/20 bg-red-400/10 text-red-400 text-xs">{status}</Badge>;
  }
  return <Badge variant="outline" className="text-muted-foreground text-xs">{status}</Badge>;
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
    <div className="px-6 py-6">
      <div className="grid grid-cols-3 gap-6">
        {/* Left column */}
        <div className="col-span-2 flex flex-col gap-6">
          {/* Stats bar */}
          <div className="grid grid-cols-4 gap-3">
            <Card size="sm">
              <CardContent>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Agents</p>
                <p className="mt-1 font-mono text-lg tabular-nums text-foreground">{agentCount}</p>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardContent>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Environments</p>
                <p className="mt-1 font-mono text-lg tabular-nums text-foreground">{envCount}</p>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardContent>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Active Sessions</p>
                <p className="mt-1 font-mono text-lg tabular-nums text-foreground">{activeSessions}</p>
              </CardContent>
            </Card>
            <Card size="sm">
              <CardContent>
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Total Sessions</p>
                <p className="mt-1 font-mono text-lg tabular-nums text-foreground">{totalSessions}</p>
              </CardContent>
            </Card>
          </div>

          {/* Recent Activity */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
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

          {/* API Key display */}
          <Card size="sm" className="mt-2">
            <CardContent>
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Key className="size-3.5" />
                API Key
              </div>
              {apiKey ? (
                <code className="mt-2 block rounded bg-muted px-2 py-1.5 font-mono text-xs text-foreground break-all select-all">
                  {apiKey}
                </code>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">No API key found</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
