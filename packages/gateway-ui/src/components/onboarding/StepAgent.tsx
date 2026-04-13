import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MODELS, ENGINES } from "@/lib/constants";

interface Props { onNext: (data: { name: string; engine: string; model: string }) => void; }

export function StepAgent({ onNext }: Props) {
  const [name, setName] = useState("Coder");
  const [engine, setEngine] = useState("claude");
  const [model, setModel] = useState(MODELS.claude[0]);
  return (
    <div className="w-full max-w-md flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 1 of 4</p>
        <h2 className="text-lg font-semibold text-foreground">Create an Agent</h2>
        <p className="text-sm text-muted-foreground mt-1">Pick a name, engine, and model for your coding agent.</p>
      </div>
      <div className="flex flex-col gap-3">
        <Input placeholder="Agent name" value={name} onChange={(e) => setName(e.target.value)}
          className="h-10 w-full border-border bg-muted text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-ring" />
        <Select value={engine} onValueChange={(v) => { setEngine(v); setModel(MODELS[v][0]); }}>
          <SelectTrigger className="h-10 w-full border-border bg-muted text-sm text-muted-foreground"><SelectValue /></SelectTrigger>
          <SelectContent>{ENGINES.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="h-10 w-full border-border bg-muted text-sm text-muted-foreground"><SelectValue /></SelectTrigger>
          <SelectContent>{(MODELS[engine] ?? []).map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={() => onNext({ name, engine, model })} disabled={!name.trim()}>
        Continue
      </Button>
    </div>
  );
}
