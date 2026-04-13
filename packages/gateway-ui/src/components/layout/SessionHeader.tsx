import { Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAppStore } from "@/stores/app-store";
import { useSession } from "@/hooks/use-sessions";
import { AgentPopover } from "@/components/popovers/AgentPopover";
import { EnvironmentPopover } from "@/components/popovers/EnvironmentPopover";

export function SessionHeader() {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const { debugOpen, toggleDebug } = useAppStore();
  const { data: session } = useSession(sessionId);

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1 text-muted-foreground" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          {session ? (
            <>
              <BreadcrumbItem className="hidden md:block">
                <AgentPopover agentId={session.agent.id}>
                  <button className="text-sm font-medium hover:text-foreground transition-colors">
                    {session.title || "Agent"}
                  </button>
                </AgentPopover>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <EnvironmentPopover envId={session.environment_id}>
                  <BreadcrumbPage className="font-mono text-xs cursor-pointer hover:text-foreground transition-colors">
                    env
                  </BreadcrumbPage>
                </EnvironmentPopover>
              </BreadcrumbItem>
            </>
          ) : (
            <BreadcrumbItem>
              <BreadcrumbPage>No session selected</BreadcrumbPage>
            </BreadcrumbItem>
          )}
        </BreadcrumbList>
      </Breadcrumb>

      {session && (
        <Badge
          variant={session.status === "running" ? "default" : "outline"}
          className={cn("h-5 px-1.5 text-xs font-medium", session.status === "running"
            ? "bg-lime-400/15 text-lime-400 border-lime-400/20"
            : "text-muted-foreground"
          )}
        >
          {session.status}
        </Badge>
      )}

      <div className="flex-1" />

      <Button
        variant="ghost"
        size="sm"
        className={cn("h-7 gap-1.5 text-xs", debugOpen
          ? "bg-accent/10 text-accent"
          : "text-muted-foreground hover:text-foreground"
        )}
        onClick={toggleDebug}
      >
        <Bug className="size-3" />
        Debug
      </Button>
    </header>
  );
}
