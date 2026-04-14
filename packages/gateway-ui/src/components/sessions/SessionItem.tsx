import { X } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useArchiveSession } from "@/hooks/use-sessions";
import { useAgents } from "@/hooks/use-agents";
import { useEnvironments } from "@/hooks/use-environments";
import { useProviderStatus } from "@/hooks/use-providers";
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Props {
  session: {
    id: string;
    status: string;
    title: string | null;
    created_at: number;
    archived_at: number | null;
    agent?: { id: string };
    environment_id?: string;
  };
}

export function SessionItem({ session }: Props) {
  const { activeSessionId, setActiveSessionId } = useAppStore();
  const archive = useArchiveSession();
  const isActive = activeSessionId === session.id;
  const { data: agents } = useAgents();
  const { data: environments } = useEnvironments();
  const { data: providerStatus } = useProviderStatus();

  const agent = agents?.find((a) => a.id === session.agent?.id);
  const env = environments?.find((e) => e.id === session.environment_id);
  const providerName = env?.config?.provider || "sprites";
  const status = providerStatus?.[providerName];
  const providerAvailable = status?.available ?? true;

  const subtitle = [agent?.name, providerName].filter(Boolean).join(" · ");

  const item = (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        onClick={() => setActiveSessionId(session.id)}
        className={`text-xs h-auto py-1.5 ${!providerAvailable ? "opacity-50" : ""}`}
      >
        <div className="flex flex-col items-start gap-0.5 min-w-0">
          <div className="flex items-center gap-1.5 w-full">
            {session.status === "running" && providerAvailable && (
              <div className="size-1.5 shrink-0 rounded-full bg-lime-400 shadow-[0_0_6px_oklch(0.84_0.18_128/0.5)]" />
            )}
            {!providerAvailable && (
              <div className="size-1.5 shrink-0 rounded-full bg-destructive" />
            )}
            <span className="truncate">{session.title || session.id.slice(0, 12)}</span>
          </div>
          {subtitle && (
            <span className="text-[10px] text-muted-foreground truncate w-full">
              {subtitle}
            </span>
          )}
        </div>
      </SidebarMenuButton>
      {!session.archived_at && (
        <SidebarMenuAction onClick={() => archive.mutate(session.id)}>
          <X className="size-3" />
        </SidebarMenuAction>
      )}
    </SidebarMenuItem>
  );

  if (!providerAvailable && status?.message) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{item}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs">
          <p className="text-xs">{status.message}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return item;
}
