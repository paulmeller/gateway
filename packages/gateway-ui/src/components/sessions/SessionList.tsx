import { useSessions } from "@/hooks/use-sessions";
import { SessionItem } from "./SessionItem";
import {
  SidebarMenu,
} from "@/components/ui/sidebar";

export function SessionList() {
  const { data: sessions, isLoading } = useSessions();

  if (isLoading) {
    return <p className="px-4 py-2 text-xs text-muted-foreground">Loading...</p>;
  }

  if (!sessions?.length) {
    return <p className="px-4 py-2 text-xs text-muted-foreground">No sessions yet</p>;
  }

  const active = sessions.filter((s) => s.status === "running");
  const recent = sessions.filter((s) => s.status !== "running" && !s.archived_at);
  const archived = sessions.filter((s) => s.archived_at);

  return (
    <SidebarMenu>
      {active.length > 0 && <Group label="Active" sessions={active} />}
      {recent.length > 0 && <Group label="Recent" sessions={recent} />}
      {archived.length > 0 && <Group label="Archived" sessions={archived} />}
    </SidebarMenu>
  );
}

function Group({ label, sessions }: { label: string; sessions: Array<{ id: string; status: string; title: string | null; created_at: number; archived_at: number | null }> }) {
  return (
    <div className="mb-1">
      <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/25">
        {label}
      </p>
      {sessions.map((s) => <SessionItem key={s.id} session={s} />)}
    </div>
  );
}
