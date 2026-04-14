import { useEffect, useRef } from "react";
import { useEvents } from "@/hooks/use-events";
import { useSSE } from "@/hooks/use-sse";
import { useAppStore } from "@/stores/app-store";
import { MessageBubble } from "./MessageBubble";
import { TypingIndicator } from "./TypingIndicator";
import { BootProgress } from "./BootProgress";
import { useSession } from "@/hooks/use-sessions";
import { useAgent } from "@/hooks/use-agents";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";

const MESSAGE_TYPES = new Set([
  "user.message", "agent.message", "agent.thinking",
  "agent.tool_use", "agent.custom_tool_use", "agent.tool_result", "session.error",
]);

export function ChatThread() {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const { data: events } = useEvents(sessionId);
  const { data: session } = useSession(sessionId);
  const { data: agent } = useAgent(session?.agent?.id ?? null);
  const bottomRef = useRef<HTMLDivElement>(null);
  useSSE(sessionId);

  const messages = events?.filter((e) => MESSAGE_TYPES.has(e.type)) ?? [];
  const isRunning = session?.status === "running";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  if (!sessionId) {
    return <OnboardingWizard />;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl py-6 px-4">
        {agent && (
          <div className="mb-4 flex items-center gap-2">
            <span className="size-2 rounded-full bg-lime-400 shadow-[0_0_6px_rgba(163,230,53,0.5)]" />
            <span className="text-xs font-medium text-foreground">{agent.name}</span>
            <span className="text-xs text-muted-foreground font-mono">{agent.model}</span>
          </div>
        )}
        {messages.length === 0 && session && <BootProgress />}
        {messages.map((event) => <MessageBubble key={event.id} event={event} />)}
        {isRunning && messages.length > 0 && <TypingIndicator />}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
