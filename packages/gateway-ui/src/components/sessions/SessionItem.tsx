import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { useArchiveSession } from "@/hooks/use-sessions";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
} from "@/components/ui/sidebar";

interface Props {
  session: { id: string; status: string; title: string | null; created_at: number; archived_at: number | null };
}

export function SessionItem({ session }: Props) {
  const { activeSessionId, setActiveSessionId } = useAppStore();
  const archive = useArchiveSession();
  const isActive = activeSessionId === session.id;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={() => setActiveSessionId(session.id)}
        className="text-xs"
      >
        {session.status === "running" && (
          <div className="size-1.5 shrink-0 rounded-full bg-lime-400 shadow-[0_0_6px_oklch(0.84_0.18_128/0.5)]" />
        )}
        <span className="truncate">{session.title || session.id.slice(0, 12)}</span>
      </SidebarMenuButton>
      {!session.archived_at && (
        <SidebarMenuAction onClick={() => archive.mutate(session.id)}>
          <X className="size-3" />
        </SidebarMenuAction>
      )}
    </SidebarMenuItem>
  );
}
