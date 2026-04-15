import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateAgent } from "@/hooks/use-agents";
import { toast } from "sonner";

interface Props {
  agent: { id: string; name: string; [key: string]: unknown } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentEditorDialog({ agent, open, onOpenChange }: Props) {
  const update = useUpdateAgent();
  const [json, setJson] = useState("");

  useEffect(() => {
    if (open && agent) {
      // Strip read-only fields before showing in editor
      const editable: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(agent)) {
        if (!["id", "created_at", "updated_at", "version"].includes(k)) {
          editable[k] = v;
        }
      }
      setJson(JSON.stringify(editable, null, 2));
    } else if (!open) {
      setJson("");
    }
  }, [open, agent]);

  async function handleSave() {
    if (!agent) return;
    try {
      const parsed = JSON.parse(json);
      await update.mutateAsync({ id: agent.id, ...parsed });
      toast.success("Agent updated");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof SyntaxError ? "Invalid JSON" : "Failed to update agent");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl border-border bg-card">
        <DialogHeader>
          <DialogTitle className="text-foreground">Edit {agent?.name}</DialogTitle>
        </DialogHeader>
        <Textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          className="min-h-[400px] border-border bg-muted font-mono text-xs leading-relaxed text-foreground focus-visible:ring-ring"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="bg-cta-gradient text-black font-medium hover:opacity-90" onClick={handleSave} disabled={update.isPending}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
