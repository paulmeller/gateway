import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { getEngineKey, PROVIDER_TOKENS } from "@/lib/constants";
import { useVaults } from "@/hooks/use-vaults";
import { ModeToggle } from "./ModeToggle";

interface Props {
  engine: string;
  model: string;
  provider: string;
  hasExistingVaults?: boolean;
  onNext: (secrets: Record<string, string>) => void;
  onSkip: () => void;
  onSelectVault?: (vaultId: string, vaultName: string) => void;
  onBack?: () => void;
}

export function StepSecrets({ engine, model, provider, hasExistingVaults, onNext, onSkip, onSelectVault, onBack }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
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
  const seenKeys = new Set<string>();

  // Anthropic provider requires a real API key (not OAuth token)
  if (provider === "anthropic") {
    fields.push({ key: "ANTHROPIC_API_KEY", label: "Anthropic API Key (required for hosted execution)" });
    seenKeys.add("ANTHROPIC_API_KEY");
  }

  const engineKey = getEngineKey(engine, model);
  if (engineKey && !seenKeys.has(engineKey.key)) {
    fields.push(engineKey);
    seenKeys.add(engineKey.key);
  }
  const providerToken = PROVIDER_TOKENS[provider];
  if (providerToken && !seenKeys.has(providerToken.key)) {
    fields.push({ key: providerToken.key, label: providerToken.label });
  }

  // "existing" = agent has vaults OR there are vaults to pick from
  const hasExisting = hasExistingVaults || availableVaults.length > 0;
  const [mode, setMode] = useState<"select" | "create">(hasExisting ? "select" : "create");

  // Sync default when data loads
  useEffect(() => {
    if (hasExisting) setMode("select");
  }, [hasExisting]);

  // No keys needed for this combination — just skip
  if (fields.length === 0) {
    return (
      <div className="w-full max-w-md flex flex-col gap-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 3 of 4</p>
          <h2 className="text-lg font-semibold text-foreground">Secrets</h2>
          <p className="text-sm text-muted-foreground mt-1">No API keys needed for this combination.</p>
        </div>
        <div className="flex gap-2">
          {onBack && <Button variant="outline" className="h-10 px-4 text-sm" onClick={onBack}>Back</Button>}
          <Button className="flex-1 h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={onSkip}>Continue</Button>
        </div>
      </div>
    );
  }

  function handleContinue() {
    if (mode === "select") {
      if (hasExistingVaults) {
        onSkip();
      } else {
        if (!selectedVaultId) return;
        const name = availableVaults.find(v => v.id === selectedVaultId)?.name ?? selectedVaultId;
        onSelectVault?.(selectedVaultId, name);
      }
    } else {
      onNext(values);
    }
  }

  return (
    <div className="w-full max-w-md flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 3 of 4</p>
        <h2 className="text-lg font-semibold text-foreground">Secrets</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {hasExisting
            ? "Use existing secrets or enter new API keys."
            : "These keys will be stored securely in a vault."}
        </p>
      </div>

      {hasExisting && <ModeToggle mode={mode} onModeChange={setMode} />}

      {mode === "select" && hasExisting && (
        <div className="flex flex-col gap-3">
          {hasExistingVaults ? (
            <p className="text-sm text-muted-foreground">The agent's existing vault secrets will be used for this session.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Vault</Label>
              <Select value={selectedVaultId} onValueChange={(v: string | null) => { if (v) setSelectedVaultId(v); }}>
                <SelectTrigger className="h-10 w-full text-foreground">
                  <span className="truncate">{availableVaults.find(v => v.id === selectedVaultId)?.name ?? "Select a vault"}</span>
                </SelectTrigger>
                <SelectContent>
                  {availableVaults.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name} <span className="text-muted-foreground ml-1">({v.entry_count} {v.entry_count === 1 ? "key" : "keys"})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {mode === "create" && (
        <div className="flex flex-col gap-3">
          {fields.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">{f.label}</Label>
              <Input type="password" placeholder={f.key} value={values[f.key] || ""}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                className="h-10 w-full text-foreground border-border bg-muted font-mono text-sm placeholder:text-muted-foreground focus-visible:ring-ring" />
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        {onBack && <Button variant="outline" className="h-10 px-4 text-sm" onClick={onBack}>Back</Button>}
        <Button
          className="flex-1 h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90"
          onClick={handleContinue}
          disabled={mode === "select" && !hasExistingVaults && !selectedVaultId}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
