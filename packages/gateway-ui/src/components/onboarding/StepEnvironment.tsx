import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LOCAL_PROVIDERS, CLOUD_PROVIDERS } from "@/lib/constants";
import { useEnvironments } from "@/hooks/use-environments";
import { useProviderStatus } from "@/hooks/use-providers";

type EnvResult =
  | { mode: "create"; data: { name: string; provider: string } }
  | { mode: "select"; env: { id: string; name: string; provider: string } };

interface Props { onNext: (result: EnvResult) => void; }

export function StepEnvironment({ onNext }: Props) {
  const { data: envs, isLoading } = useEnvironments();
  const { data: providerStatus } = useProviderStatus();
  const readyEnvs = envs?.filter(e => e.state === "ready") ?? [];
  const hasExisting = !isLoading && readyEnvs.length > 0;
  const [mode, setMode] = useState<"select" | "create">("create");
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("dev");
  const [provider, setProvider] = useState("");

  useEffect(() => {
    if (!isLoading) setMode(hasExisting ? "select" : "create");
  }, [isLoading, hasExisting]);

  // Auto-select first available provider
  useEffect(() => {
    if (providerStatus && !provider) {
      const allProviders = [...LOCAL_PROVIDERS, ...CLOUD_PROVIDERS];
      const first = allProviders.find(p => providerStatus[p]?.available);
      if (first) setProvider(first);
    }
  }, [providerStatus, provider]);

  function handleSelectContinue() {
    const env = readyEnvs.find(e => e.id === selectedId);
    if (!env) return;
    onNext({ mode: "select", env: { id: env.id, name: env.name, provider: env.config?.provider || "sprites" } });
  }

  function handleCreate() {
    if (!name.trim() || !provider) return;
    onNext({ mode: "create", data: { name: name.trim(), provider } });
  }

  if (isLoading) return null;

  return (
    <div className="w-full max-w-md flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 2 of 4</p>
        <h2 className="text-lg font-semibold text-foreground">Choose an Environment</h2>
        <p className="text-sm text-muted-foreground mt-1">Select an existing environment or create a new one.</p>
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
            <SelectTrigger className="h-10 w-full text-foreground"><SelectValue placeholder="Select an environment" /></SelectTrigger>
            <SelectContent>
              {readyEnvs.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name} <span className="text-muted-foreground ml-1">({e.config?.provider || "sprites"})</span>
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
          <Input placeholder="Environment name" value={name} onChange={(e) => setName(e.target.value)}
            className="h-10 w-full text-foreground" />

          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Local</p>
            <div className="flex flex-col gap-1">
              {LOCAL_PROVIDERS.map((p) => {
                const status = providerStatus?.[p];
                const available = status?.available ?? true;
                const isSelected = provider === p;
                return (
                  <button
                    key={p}
                    disabled={!available}
                    onClick={() => available && setProvider(p)}
                    className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? "border-lime-400/50 bg-lime-400/10"
                        : available
                          ? "border-border hover:border-muted-foreground/50"
                          : "border-border opacity-50 cursor-not-allowed"
                    }`}
                  >
                    <span className={`text-sm font-medium ${isSelected ? "text-foreground" : available ? "text-foreground" : "text-muted-foreground"}`}>
                      {p}
                    </span>
                    {!available && status?.message && (
                      <span className="text-xs text-muted-foreground mt-0.5">{status.message}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Cloud</p>
            <div className="flex flex-col gap-1">
              {CLOUD_PROVIDERS.map((p) => {
                const status = providerStatus?.[p];
                const available = status?.available ?? true;
                const isSelected = provider === p;
                return (
                  <button
                    key={p}
                    disabled={!available}
                    onClick={() => available && setProvider(p)}
                    className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? "border-lime-400/50 bg-lime-400/10"
                        : available
                          ? "border-border hover:border-muted-foreground/50"
                          : "border-border opacity-50 cursor-not-allowed"
                    }`}
                  >
                    <span className={`text-sm font-medium ${isSelected ? "text-foreground" : available ? "text-foreground" : "text-muted-foreground"}`}>
                      {p}
                    </span>
                    {!available && status?.message && (
                      <span className="text-xs text-muted-foreground mt-0.5">{status.message}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={handleCreate} disabled={!name.trim() || !provider}>
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}
