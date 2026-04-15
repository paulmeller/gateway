import { useState } from "react";
import { Shield, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api-client";

interface Props {
  toolName: string;
  toolInput: unknown;
  toolUseId?: string;
}

export function ToolConfirmation({ toolName, toolInput, toolUseId }: Props) {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const [responded, setResponded] = useState<"allow" | "deny" | null>(null);
  const [sending, setSending] = useState(false);

  async function handleResponse(result: "allow" | "deny") {
    if (!sessionId || responded) return;
    setSending(true);
    try {
      await api(`/sessions/${sessionId}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [{
            type: "user.tool_confirmation",
            tool_use_id: toolUseId,
            result,
          }],
        }),
      });
      setResponded(result);
    } catch {
      // best effort
    } finally {
      setSending(false);
    }
  }

  const inputStr = typeof toolInput === "string"
    ? toolInput
    : JSON.stringify(toolInput ?? {}, null, 2);

  return (
    <div className="py-1.5">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
        <div className="flex items-center gap-2 mb-2">
          <Shield className="size-3.5 text-amber-400" />
          <span className="text-xs font-medium text-amber-400">Tool Confirmation Required</span>
        </div>
        <div className="mb-2">
          <span className="font-mono text-xs text-foreground">{toolName}</span>
        </div>
        <pre className="rounded bg-muted px-3 py-2 text-xs text-muted-foreground max-h-32 overflow-y-auto whitespace-pre-wrap mb-3">
          {inputStr.slice(0, 1000)}
        </pre>

        {responded ? (
          <div className="flex items-center gap-1.5 text-xs">
            {responded === "allow" ? (
              <>
                <Check className="size-3 text-lime-400" />
                <span className="text-lime-400">Allowed</span>
              </>
            ) : (
              <>
                <X className="size-3 text-destructive" />
                <span className="text-destructive">Denied</span>
              </>
            )}
          </div>
        ) : (
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 bg-lime-400/20 text-lime-400 hover:bg-lime-400/30 border-0"
              onClick={() => handleResponse("allow")}
              disabled={sending}
            >
              <Check className="size-3 mr-1" /> Allow
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => handleResponse("deny")}
              disabled={sending}
            >
              <X className="size-3 mr-1" /> Deny
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
