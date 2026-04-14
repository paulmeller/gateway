import { useState, useEffect } from "react";
import { Check, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LOCAL_PROVIDERS, CLOUD_PROVIDERS } from "@/lib/constants";
import { useEnvironments } from "@/hooks/use-environments";
import { useProviderStatus, type ProviderStatus } from "@/hooks/use-providers";
import { toast } from "sonner";

const PROVIDER_DOMAINS: Record<string, string> = {
  docker: "docker.com",
  "apple-container": "apple.com",
  podman: "podman.io",
  sprites: "sprites.dev",
  e2b: "e2b.dev",
  vercel: "vercel.com",
  daytona: "daytona.io",
  fly: "fly.io",
  modal: "modal.com",
};

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
    if (envs?.some(e => e.name.toLowerCase() === name.trim().toLowerCase())) {
      toast.error(`Environment "${name.trim()}" already exists — use a different name or select existing`);
      return;
    }
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

          <ProviderGroup label="Local" providers={LOCAL_PROVIDERS} providerStatus={providerStatus} selected={provider} onSelect={setProvider} />
          <ProviderGroup label="Cloud" providers={CLOUD_PROVIDERS} providerStatus={providerStatus} selected={provider} onSelect={setProvider} cloud />

          <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={handleCreate} disabled={!name.trim() || !provider}>
            Continue
          </Button>
        </div>
      )}
    </div>
  );
}

function ProviderGroup({
  label,
  providers,
  providerStatus,
  selected,
  onSelect,
  cloud,
}: {
  label: string;
  providers: readonly string[];
  providerStatus: Record<string, ProviderStatus> | undefined;
  selected: string;
  onSelect: (p: string) => void;
  cloud?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
      <div className="grid grid-cols-3 gap-1.5">
        {providers.map((p) => {
          const status = providerStatus?.[p];
          const available = cloud ? true : (status?.available ?? true);
          const isSelected = selected === p;
          return (
            <button
              key={p}
              disabled={!available}
              onClick={() => available && onSelect(p)}
              className={`relative flex flex-col items-center justify-center rounded-lg border px-2 py-2.5 text-center transition-colors ${
                isSelected
                  ? "border-lime-400/50 bg-lime-400/10"
                  : available
                    ? "border-border hover:border-muted-foreground/50"
                    : "border-border opacity-40 cursor-not-allowed"
              }`}
            >
              {isSelected && (
                <Check className="absolute top-1 right-1 size-3 text-lime-400" />
              )}
              {!cloud && !available && status?.message && (
                <Tooltip>
                  <TooltipTrigger asChild onClick={(e) => e.stopPropagation()}>
                    <div className="absolute top-1 left-1 rounded-full p-0.5 text-muted-foreground hover:text-foreground">
                      <Info className="size-3" />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-xs">{status.message}</p>
                  </TooltipContent>
                </Tooltip>
              )}
              <img
                src={`https://www.google.com/s2/favicons?domain=${PROVIDER_DOMAINS[p] ?? ""}&sz=32`}
                alt=""
                className="size-4 mb-1"
              />
              <span className={`text-xs font-medium ${isSelected ? "text-foreground" : available ? "text-foreground" : "text-muted-foreground"}`}>
                {p}
              </span>
              {cloud && (
                <span className="text-[10px] text-muted-foreground mt-0.5">API key required</span>
              )}
              {!cloud && !available && (
                <span className="text-[10px] text-destructive/70 mt-0.5">Unavailable</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
