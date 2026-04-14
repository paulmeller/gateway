import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useUpdateAgent, type Agent } from "@/hooks/use-agents";
import { toast } from "sonner";

interface Props {
  agent: Agent;
}

export function AgentAdvancedTab({ agent }: Props) {
  const update = useUpdateAgent();
  const [webhookUrl, setWebhookUrl] = useState(agent.webhook_url || "");
  const [webhookEvents, setWebhookEvents] = useState(
    (agent.webhook_events ?? []).join(", ")
  );
  const [callableAgents, setCallableAgents] = useState(
    (agent.callable_agents ?? []).join(", ")
  );
  const dirty =
    webhookUrl !== (agent.webhook_url || "") ||
    webhookEvents !== (agent.webhook_events ?? []).join(", ") ||
    callableAgents !== (agent.callable_agents ?? []).join(", ");

  async function handleSave() {
    try {
      await update.mutateAsync({
        id: agent.id,
        webhook_url: webhookUrl || undefined,
        webhook_events: webhookEvents
          ? webhookEvents.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        callable_agents: callableAgents
          ? callableAgents.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      });
      toast.success("Agent updated");
    } catch {
      toast.error("Failed to update agent");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Tools */}
      {agent.tools && agent.tools.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label className="text-sm text-foreground">Tools</Label>
          <div className="flex flex-wrap gap-1.5">
            {agent.tools.map((t, i) => (
              <Badge key={i} variant="outline" className="text-xs">
                {typeof t === "string"
                  ? t
                  : (t as { name?: string })?.name ?? JSON.stringify(t)}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* MCP Servers */}
      {agent.mcp_servers && agent.mcp_servers.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label className="text-sm text-foreground">MCP Servers</Label>
          <pre className="rounded bg-muted p-3 text-xs text-muted-foreground max-h-48 overflow-y-auto">
            {JSON.stringify(agent.mcp_servers, null, 2)}
          </pre>
        </div>
      )}

      {/* Webhook */}
      <div className="flex flex-col gap-3">
        <Label className="text-sm text-foreground">Webhook</Label>
        <Input
          placeholder="https://example.com/webhook"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          className="text-foreground"
        />
        <Input
          placeholder="Events (comma-separated): session.created, turn.complete"
          value={webhookEvents}
          onChange={(e) => setWebhookEvents(e.target.value)}
          className="text-foreground"
        />
      </div>

      {/* Callable Agents */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm text-foreground">Callable Agents</Label>
        <Input
          placeholder="Agent IDs (comma-separated)"
          value={callableAgents}
          onChange={(e) => setCallableAgents(e.target.value)}
          className="text-foreground"
        />
        <p className="text-xs text-muted-foreground">
          Other agents this agent can spawn as child sessions
        </p>
      </div>

      {dirty && (
        <div className="flex justify-end">
          <Button
            className="bg-cta-gradient text-black font-medium hover:opacity-90"
            onClick={handleSave}
            disabled={update.isPending}
          >
            {update.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      )}
    </div>
  );
}
