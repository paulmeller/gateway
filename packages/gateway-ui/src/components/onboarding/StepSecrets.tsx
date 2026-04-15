import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getEngineKey, PROVIDER_TOKENS } from "@/lib/constants";
import { useVaults } from "@/hooks/use-vaults";

interface Props {
  engine: string;
  model: string;
  provider: string;
  hasExistingVaults?: boolean;
  onNext: (secrets: Record<string, string>) => void;
  onSkip: () => void;
  onSelectVault?: (vaultId: string) => void;
}

export function StepSecrets({ engine, model, provider, hasExistingVaults, onNext, onSkip, onSelectVault }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"existing" | "vault" | "new">(hasExistingVaults ? "existing" : "new");
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const { data: vaults } = useVaults();
  // Deduplicate by name — keep the most recent (first in list, API returns desc)
  const seen = new Set<string>();
  const availableVaults = (vaults ?? []).filter(v => {
    if (seen.has(v.name)) return false;
    seen.add(v.name);
    return true;
  });

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

  const showVaultOption = availableVaults.length > 0;

  // If current mode isn't available, fall back to "new"
  useEffect(() => {
    if (mode === "existing" && !hasExistingVaults) setMode("new");
    if (mode === "vault" && !showVaultOption) setMode("new");
  }, [mode, hasExistingVaults, showVaultOption]);

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

      {(hasExistingVaults || showVaultOption) && (
        <div className="flex rounded-lg border border-border overflow-hidden">
          {hasExistingVaults && (
            <button
              className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${mode === "existing" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setMode("existing")}
            >
              Use existing
            </button>
          )}
          {showVaultOption && (
            <button
              className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${mode === "vault" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setMode("vault")}
            >
              From vault
            </button>
          )}
          <button
            className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${mode === "new" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setMode("new")}
          >
            Enter keys
          </button>
        </div>
      )}


      {mode === "existing" && hasExistingVaults && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">The agent's existing vault secrets will be used for this session.</p>
          <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={onSkip}>Continue</Button>
        </div>
      )}

      {mode === "vault" && (
        <div className="flex flex-col gap-3">
          <Select value={selectedVaultId} onValueChange={setSelectedVaultId}>
            <SelectTrigger className="h-10 w-full text-foreground">
              <SelectValue placeholder="Select a vault" />
            </SelectTrigger>
            <SelectContent>
              {availableVaults.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name} <span className="text-muted-foreground ml-1">({v.entry_count} {v.entry_count === 1 ? "key" : "keys"})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90"
            onClick={() => onSelectVault?.(selectedVaultId)}
            disabled={!selectedVaultId}
          >
            Continue
          </Button>
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
          <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={() => onNext(values)}>Save & Continue</Button>
        </>
      )}
    </div>
  );
}
