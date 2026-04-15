import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/settings/PageHeader";
import { useSessions } from "@/hooks/use-sessions";
import { useAgents } from "@/hooks/use-agents";
import { useEnvironments } from "@/hooks/use-environments";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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

// ─── SessionsPage ─────────────────────────────────────────────────────────────

export function SessionsPage() {
  const { data: sessions } = useSessions();
  const { data: agents } = useAgents();
  const { data: environments } = useEnvironments();

  return (
    <div className="mx-auto max-w-5xl px-6 py-6 flex flex-col gap-6">
      <PageHeader
        title="Sessions"
        description="View and manage agent sessions."
      />

      {sessions && sessions.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Environment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => {
                const agentName =
                  agents?.find((a) => a.id === session.agent?.id)?.name ??
                  session.agent?.id?.slice(0, 8) ??
                  "—";
                const envName =
                  environments?.find((e) => e.id === session.environment_id)?.name ??
                  session.environment_id?.slice(0, 8) ??
                  "—";

                return (
                  <TableRow
                    key={session.id}
                    className="cursor-pointer hover:bg-accent/30"
                  >
                    <TableCell className="font-medium text-foreground">
                      <Link
                        to="/sessions/$id"
                        params={{ id: session.id }}
                        className="hover:underline"
                      >
                        {session.title ?? session.id.slice(0, 12) + "…"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{agentName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{envName}</TableCell>
                    <TableCell>{statusBadge(session.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{timeAgo(session.created_at)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">No sessions yet.</p>
      )}
    </div>
  );
}
