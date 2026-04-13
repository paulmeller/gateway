import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PROVIDERS } from "@/lib/constants";

interface Props { onNext: (data: { name: string; provider: string }) => void; }

export function StepEnvironment({ onNext }: Props) {
  const [name, setName] = useState("dev");
  const [provider, setProvider] = useState("docker");
  return (
    <div className="w-full max-w-md flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 2 of 4</p>
        <h2 className="text-lg font-semibold text-foreground">Create an Environment</h2>
        <p className="text-sm text-muted-foreground mt-1">Choose where your agent's containers will run.</p>
      </div>
      <div className="flex flex-col gap-3">
        <Input placeholder="Environment name" value={name} onChange={(e) => setName(e.target.value)}
          className="h-10 w-full border-border bg-muted text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-ring" />
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className="h-10 w-full border-border bg-muted text-sm text-muted-foreground"><SelectValue /></SelectTrigger>
          <SelectContent>{PROVIDERS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={() => onNext({ name, provider })} disabled={!name.trim()}>
        Continue
      </Button>
    </div>
  );
}
