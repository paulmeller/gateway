import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateAgent } from "@/hooks/use-agents";
import { MODELS, ENGINES } from "@/lib/constants";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateAgentDialog({ open, onOpenChange }: Props) {
  const create = useCreateAgent();
  const [name, setName] = useState("");
  const [engine, setEngine] = useState("claude");
  const [model, setModel] = useState(MODELS.claude[0]);

  async function handleCreate() {
    if (!name.trim()) return;
    try {
      await create.mutateAsync({ name: name.trim(), engine, model });
      setName("");
      toast.success("Agent created");
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = (err as { body?: { error?: { message?: string } } })?.body?.error?.message
        || (err instanceof Error ? err.message : "Failed to create agent");
      toast.error(msg);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 pt-2">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input placeholder="My Agent" value={name} onChange={(e) => setName(e.target.value)} className="w-full text-foreground" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Engine</Label>
            <Select value={engine} onValueChange={(v: string | null) => { if (v) { setEngine(v); setModel(MODELS[v][0]); } }}>
              <SelectTrigger className="w-full text-foreground"><SelectValue /></SelectTrigger>
              <SelectContent>{ENGINES.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Model</Label>
            <Select value={model} onValueChange={(v: string | null) => { if (v) setModel(v); }}>
              <SelectTrigger className="w-full text-foreground"><SelectValue /></SelectTrigger>
              <SelectContent>{(MODELS[engine] ?? []).map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button className="bg-cta-gradient text-black hover:opacity-90" onClick={handleCreate} disabled={!name.trim() || create.isPending}>Create</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
