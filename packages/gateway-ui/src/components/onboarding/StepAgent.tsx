import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ENGINES, FALLBACK_MODELS } from "@/lib/constants";
import { ModelCombobox } from "@/components/ModelCombobox";
import { useAgents } from "@/hooks/use-agents";
import { toast } from "sonner";
import { ModeToggle } from "./ModeToggle";

export type AgentResult =
  | { mode: "create"; data: { name: string; engine: string; model: string } }
  | { mode: "select"; agent: { id: string; name: string; engine: string; model: string } };

interface Props { onNext: (result: AgentResult) => void; }

export function StepAgent({ onNext }: Props) {
  const { data: agents, isLoading, isError } = useAgents();
  const hasExisting = !isLoading && !isError && agents && agents.length > 0;
  const [mode, setMode] = useState<"select" | "create">("create");
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("my-agent");
  const [engine, setEngine] = useState("claude");
  const [model, setModel] = useState(FALLBACK_MODELS.claude[0]);

  useEffect(() => {
    if (!isLoading) setMode(hasExisting ? "select" : "create");
  }, [isLoading, hasExisting]);

  function handleContinue() {
    if (mode === "select") {
      const agent = agents?.find(a => a.id === selectedId);
      if (!agent) { toast.error("Please select an agent"); return; }
      onNext({ mode: "select", agent: { id: agent.id, name: agent.name, engine: agent.engine, model: agent.model } });
    } else {
      if (!name.trim()) { toast.error("Agent name is required"); return; }
      if (agents?.some(a => a.name.toLowerCase() === name.trim().toLowerCase())) {
        toast.error(`Agent "${name.trim()}" already exists — pick a different name or select it`);
        return;
      }
      onNext({ mode: "create", data: { name: name.trim(), engine, model } });
    }
  }

  if (isLoading) return null;

  if (isError) {
    return (
      <div className="w-full max-w-md flex flex-col gap-4">
        <p className="text-sm text-destructive">Failed to load agents. Check that the server is running.</p>
        <Button variant="outline" onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 1 of 4</p>
        <h2 className="text-lg font-semibold text-foreground">Choose an Agent</h2>
        <p className="text-sm text-muted-foreground mt-1">Select an existing agent or create a new one.</p>
      </div>

      {hasExisting && <ModeToggle mode={mode} onModeChange={setMode} />}

      {mode === "select" && hasExisting && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Agent</Label>
            <Select value={selectedId} onValueChange={(v: string | null) => { if (v) setSelectedId(v); }}>
              <SelectTrigger className="h-10 w-full text-foreground">
                <span className="truncate">{agents?.find(a => a.id === selectedId)?.name ?? "Select an agent"}</span>
              </SelectTrigger>
              <SelectContent>
                {agents!.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} <span className="text-muted-foreground ml-1">({a.engine})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {mode === "create" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input placeholder="my-agent" value={name} onChange={(e) => setName(e.target.value)} className="h-10 w-full text-foreground" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Engine</Label>
            <Select value={engine} onValueChange={(v: string | null) => { if (v) { setEngine(v); setModel(FALLBACK_MODELS[v]?.[0] ?? ""); } }}>
              <SelectTrigger className="h-10 w-full text-foreground"><SelectValue /></SelectTrigger>
              <SelectContent>{ENGINES.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Model</Label>
            <ModelCombobox engine={engine} value={model} onChange={setModel} />
          </div>
        </div>
      )}

      <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={handleContinue} disabled={mode === "select" && !selectedId}>
        Continue
      </Button>
    </div>
  );
}
