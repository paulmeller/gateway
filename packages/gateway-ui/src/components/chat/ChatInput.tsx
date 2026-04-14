import { useRef, useState } from "react";
import { ArrowUp, Square, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-sessions";
import { useEnvironments } from "@/hooks/use-environments";
import { useProviderStatus } from "@/hooks/use-providers";

export function ChatInput() {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();

  const { data: session } = useSession(sessionId);
  const { data: environments } = useEnvironments();
  const { data: providerStatus } = useProviderStatus();

  const env = environments?.find((e) => e.id === session?.environment_id);
  const providerName = env?.config?.provider || "sprites";
  const status = providerStatus?.[providerName];
  const providerAvailable = status?.available ?? true;
  const isRunning = session?.status === "running";

  async function handleSend() {
    if (!sessionId || !text.trim() || sending || !providerAvailable) return;
    const msg = text.trim();
    setText("");
    setSending(true);
    try {
      await api(`/sessions/${sessionId}/events`, {
        method: "POST",
        body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: msg }] }] }),
      });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }

  async function handleStop() {
    if (!sessionId) return;
    try {
      await api(`/sessions/${sessionId}/events`, {
        method: "POST",
        body: JSON.stringify({ events: [{ type: "interrupt" }] }),
      });
    } catch { /* best effort */ }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  if (!sessionId) return null;

  return (
    <div className="shrink-0 border-t border-border bg-background px-4 py-3">
      {!providerAvailable && status?.message && (
        <div className="mx-auto max-w-3xl mb-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="size-4 shrink-0 text-destructive" />
          <p className="text-xs text-destructive">{status.message}</p>
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={providerAvailable ? "Message..." : "Provider unavailable"}
          disabled={!providerAvailable}
          className="min-h-[44px] max-h-[200px] resize-none border-border bg-muted text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-ring disabled:opacity-50"
          rows={1}
        />
        {isRunning ? (
          <Button
            size="icon"
            className="size-[44px] shrink-0 bg-red-500 text-white hover:bg-red-600 animate-pulse"
            onClick={handleStop}
          >
            <Square className="size-3.5" />
          </Button>
        ) : (
          <Button
            size="icon"
            className="size-[44px] shrink-0 bg-cta-gradient text-black hover:opacity-90 disabled:opacity-30"
            onClick={handleSend}
            disabled={!text.trim() || sending || !providerAvailable}
          >
            <ArrowUp className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
