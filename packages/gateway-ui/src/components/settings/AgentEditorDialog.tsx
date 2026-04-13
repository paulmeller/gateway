import { useState } from "react";
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

  function handleOpen(isOpen: boolean) {
    if (isOpen && agent) {
      const { id: _id, created_at: _ca, updated_at: _ua, ...rest } = agent;
      void _id; void _ca; void _ua;
      setJson(JSON.stringify(rest, null, 2));
    }
    onOpenChange(isOpen);
  }

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
    <Dialog open={open} onOpenChange={handleOpen}>
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
