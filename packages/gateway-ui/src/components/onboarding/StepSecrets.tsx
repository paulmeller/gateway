import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getEngineKey, PROVIDER_TOKENS } from "@/lib/constants";

interface Props {
  engine: string;
  model: string;
  provider: string;
  hasExistingVaults?: boolean;
  onNext: (secrets: Record<string, string>) => void;
  onSkip: () => void;
}

export function StepSecrets({ engine, model, provider, hasExistingVaults, onNext, onSkip }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"existing" | "new">(hasExistingVaults ? "existing" : "new");
  const fields: Array<{ key: string; label: string }> = [];
  const engineKey = getEngineKey(engine, model);
  if (engineKey) fields.push(engineKey);
  const providerToken = PROVIDER_TOKENS[provider];
  if (providerToken) fields.push({ key: providerToken.key, label: providerToken.label });

  if (fields.length === 0) {
    return (
      <div className="w-full max-w-md flex flex-col gap-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 3 of 4</p>
          <h2 className="text-lg font-semibold text-foreground">Secrets</h2>
          <p className="text-sm text-muted-foreground mt-1">No API keys needed for this combination.</p>
        </div>
        <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={onSkip}>Continue</Button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 3 of 4</p>
        <h2 className="text-lg font-semibold text-foreground">Secrets</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {hasExistingVaults
            ? "This agent already has secrets configured. You can use them or add new ones."
            : "These keys will be stored securely in a vault."}
        </p>
      </div>

      {hasExistingVaults && (
        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${mode === "existing" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setMode("existing")}
          >
            Use existing
          </button>
          <button
            className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${mode === "new" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setMode("new")}
          >
            Add new
          </button>
        </div>
      )}

      {mode === "existing" && hasExistingVaults && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">The agent's existing vault secrets will be used for this session.</p>
          <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={onSkip}>Continue</Button>
        </div>
      )}

      {mode === "new" && (
        <>
          <div className="flex flex-col gap-3">
            {fields.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">{f.label}</Label>
                <Input type="password" placeholder={f.key} value={values[f.key] || ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  className="h-10 w-full text-foreground border-border bg-muted font-mono text-sm placeholder:text-muted-foreground focus-visible:ring-ring" />
              </div>
            ))}
          </div>
          <div className="flex gap-3">
            <Button variant="ghost" className="flex-1 h-10 text-sm text-muted-foreground hover:text-foreground ring-1 ring-border" onClick={onSkip}>Skip</Button>
            <Button className="flex-1 h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={() => onNext(values)}>Save & Continue</Button>
          </div>
        </>
      )}
    </div>
  );
}
