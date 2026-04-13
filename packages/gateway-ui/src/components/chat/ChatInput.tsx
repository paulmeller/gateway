import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";

export function ChatInput() {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const qc = useQueryClient();

  async function handleSend() {
    if (!sessionId || !text.trim() || sending) return;
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

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  if (!sessionId) return null;

  return (
    <div className="shrink-0 border-t border-border bg-background px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message..."
          className="min-h-[44px] max-h-[200px] resize-none border-border bg-muted text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-ring"
          rows={1}
        />
        <Button
          size="icon"
          className="size-[44px] shrink-0 bg-cta-gradient text-black hover:opacity-90 disabled:opacity-30"
          onClick={handleSend}
          disabled={!text.trim() || sending}
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}
