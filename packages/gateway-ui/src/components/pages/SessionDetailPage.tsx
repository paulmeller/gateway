import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/hooks/use-sessions";
import { useAgents } from "@/hooks/use-agents";
import { useAppStore } from "@/stores/app-store";
import { EventStream } from "@/components/events/EventStream";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── SessionDetailPage ────────────────────────────────────────────────────────

interface Props {
  id: string;
}

export function SessionDetailPage({ id }: Props) {
  const { data: session } = useSession(id);
  const { data: agents } = useAgents();
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);

  useEffect(() => {
    setActiveSessionId(id);
  }, [id, setActiveSessionId]);

  const agentName =
    agents?.find((a) => a.id === session?.agent?.id)?.name ??
    session?.agent?.id?.slice(0, 8) ??
    "—";

  return (
    <div className="mx-auto max-w-5xl px-6 py-6 flex flex-col gap-4">
      {/* Back button */}
      <div>
        <Link
          to="/sessions"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          All Sessions
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-foreground">
            {session?.title ?? id.slice(0, 12) + "…"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Agent: <span className="text-foreground">{agentName}</span>
          </p>
        </div>
        {session && statusBadge(session.status)}
      </div>

      {/* Event stream */}
      <div className="rounded-lg border border-border overflow-hidden" style={{ minHeight: 400 }}>
        <EventStream />
      </div>
    </div>
  );
}
