import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MODELS, ENGINES } from "@/lib/constants";
import { useAgents } from "@/hooks/use-agents";

type AgentResult =
  | { mode: "create"; data: { name: string; engine: string; model: string } }
  | { mode: "select"; agent: { id: string; name: string; engine: string; model: string } };

interface Props { onNext: (result: AgentResult) => void; }

export function StepAgent({ onNext }: Props) {
  const { data: agents, isLoading } = useAgents();
  const hasExisting = !isLoading && agents && agents.length > 0;
  const [mode, setMode] = useState<"select" | "create">("create");
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("Coder");
  const [engine, setEngine] = useState("claude");
  const [model, setModel] = useState(MODELS.claude[0]);

  useEffect(() => {
    if (!isLoading) setMode(hasExisting ? "select" : "create");
  }, [isLoading, hasExisting]);

  function handleSelectContinue() {
    const agent = agents?.find(a => a.id === selectedId);
    if (!agent) return;
    onNext({ mode: "select", agent: { id: agent.id, name: agent.name, engine: agent.engine, model: agent.model } });
  }

  function handleCreate() {
    if (!name.trim()) return;
    onNext({ mode: "create", data: { name: name.trim(), engine, model } });
  }

  if (isLoading) return null;

  return (
    <div className="w-full max-w-md flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 1 of 4</p>
        <h2 className="text-lg font-semibold text-foreground">Choose an Agent</h2>
        <p className="text-sm text-muted-foreground mt-1">Select an existing agent or create a new one.</p>
      </div>

      {hasExisting && (
        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${mode === "select" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setMode("select")}
          >
            Use existing
          </button>
          <button
            className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${mode === "create" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setMode("create")}
          >
            Create new
          </button>
        </div>
      )}

      {mode === "select" && hasExisting && (
        <div className="flex flex-col gap-3">
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger className="h-10 w-full text-foreground"><SelectValue placeholder="Select an agent" /></SelectTrigger>
            <SelectContent>
              {agents!.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name} <span className="text-muted-foreground ml-1">({a.engine})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={handleSelectContinue} disabled={!selectedId}>
            Continue
          </Button>
        </div>
      )}

      {mode === "create" && (
        <div className="flex flex-col gap-3">
          <Input placeholder="Agent name" value={name} onChange={(e) => setName(e.target.value)}
            className="h-10 w-full text-foreground" />
          <Select value={engine} onValueChange={(v) => { setEngine(v); setModel(MODELS[v][0]); }}>
            <SelectTrigger className="h-10 w-full text-foreground"><SelectValue /></SelectTrigger>
            <SelectContent>{ENGINES.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="h-10 w-full text-foreground"><SelectValue /></SelectTrigger>
            <SelectContent>{(MODELS[engine] ?? []).map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
          </Select>
          <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={handleCreate} disabled={!name.trim()}>
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}
