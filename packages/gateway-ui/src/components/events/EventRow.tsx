import { useState } from "react";
import { ChevronRight, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SessionEvent } from "@/hooks/use-events";

const TYPE_STYLES: Record<string, string> = {
  user: "bg-blue-400/10 text-blue-400 border-blue-400/20",
  agent: "bg-lime-400/10 text-lime-400 border-lime-400/20",
  error: "bg-red-400/10 text-red-400 border-red-400/20",
  status: "bg-amber-400/10 text-amber-400 border-amber-400/20",
};

function badgeStyle(type: string): string {
  if (type.startsWith("user")) return TYPE_STYLES.user;
  if (type.startsWith("agent")) return TYPE_STYLES.agent;
  if (type.includes("error")) return TYPE_STYLES.error;
  if (type.includes("status")) return TYPE_STYLES.status;
  return "bg-muted text-muted-foreground border-border";
}

interface Props { event: SessionEvent; prevEvent?: SessionEvent; }

export function EventRow({ event, prevEvent }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { id, session_id, seq, type, processed_at, ...payload } = event;
  const prevTime = prevEvent?.processed_at ? new Date(prevEvent.processed_at as string).getTime() : 0;
  const curTime = event.processed_at ? new Date(event.processed_at as string).getTime() : 0;
  const delta = prevTime && curTime ? curTime - prevTime : 0;
  const preview = getPreview(event.type, event);

  return (
    <div className="border-b border-border">
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground/50 transition-transform", expanded && "rotate-90")} />
        <span className="w-5 text-right font-mono text-xs text-muted-foreground">{event.seq}</span>
        <Badge variant="outline" className={cn("h-4 rounded px-1.5 text-xs font-medium", badgeStyle(event.type))}>
          {event.type}
        </Badge>
        <span className="flex-1 truncate text-xs text-muted-foreground">{preview}</span>
        {delta > 0 && <span className="font-mono text-xs text-muted-foreground/50">+{delta}ms</span>}
      </button>
      {expanded && (
        <div className="relative border-t border-border bg-muted px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 size-5 text-muted-foreground/50 hover:text-muted-foreground"
            onClick={() => navigator.clipboard.writeText(JSON.stringify(payload, null, 2))}
          >
            <Copy className="size-3" />
          </Button>
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function getPreview(type: string, event: SessionEvent): string {
  if (type === "user.message" || type === "agent.message") {
    const content = event.content as Array<{type: string; text?: string}> | undefined;
    if (content && Array.isArray(content)) {
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
      return text.slice(0, 100);
    }
    if (typeof event.text === "string") return (event.text as string).slice(0, 100);
  }
  if (type === "agent.tool_use") return (event.name as string) || "tool";
  if (type.includes("error")) return ((event.error as {message?: string})?.message) || "";
  if (type.includes("status")) return (event.stop_reason as string) || "";
  return "";
}
