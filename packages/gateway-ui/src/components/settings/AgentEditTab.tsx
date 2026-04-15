import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateAgent, type Agent } from "@/hooks/use-agents";
import { toast } from "sonner";

interface Props {
  agent: Agent;
}

export function AgentEditTab({ agent }: Props) {
  const update = useUpdateAgent();
  const [json, setJson] = useState("");

  useEffect(() => {
    const editable: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(agent)) {
      if (!["id", "created_at", "updated_at", "version"].includes(k)) {
        editable[k] = v;
      }
    }
    setJson(JSON.stringify(editable, null, 2));
  }, [agent]);

  async function handleSave() {
    try {
      const parsed = JSON.parse(json);
      await update.mutateAsync({ id: agent.id, ...parsed });
      toast.success("Agent updated");
    } catch (err) {
      toast.error(
        err instanceof SyntaxError ? "Invalid JSON" : "Failed to update agent"
      );
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Edit the full agent configuration as JSON.
      </p>
      <Textarea
        value={json}
        onChange={(e) => setJson(e.target.value)}
        className="min-h-[400px] font-mono text-xs text-foreground leading-relaxed border-border bg-muted focus-visible:ring-ring"
      />
      <div className="flex justify-end">
        <Button
          className="bg-cta-gradient text-black font-medium hover:opacity-90"
          onClick={handleSave}
          disabled={update.isPending}
        >
          {update.isPending ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
