import { useEffect, useRef } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEvents } from "@/hooks/use-events";
import { useAppStore } from "@/stores/app-store";
import { EventRow } from "./EventRow";

export function EventStream() {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const { data: events } = useEvents(sessionId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const list = events ?? [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [list.length]);

  if (!sessionId) return <p className="p-3 text-xs text-muted-foreground/50">No session selected</p>;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{list.length} events</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-5 text-muted-foreground/50 hover:text-muted-foreground"
          onClick={() => navigator.clipboard.writeText(JSON.stringify(list, null, 2))}
        >
          <Copy className="size-3" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {list.map((event, i) => <EventRow key={event.id} event={event} prevEvent={list[i - 1]} />)}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
