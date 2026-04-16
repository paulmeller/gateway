import { useState, useEffect } from "react";
import { Check, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LOCAL_PROVIDERS, CLOUD_PROVIDERS } from "@/lib/constants";
import { useEnvironments } from "@/hooks/use-environments";
import { useProviderStatus, type ProviderStatus } from "@/hooks/use-providers";
import { toast } from "sonner";
import { ModeToggle } from "./ModeToggle";

const PROVIDER_DOMAINS: Record<string, string> = {
  anthropic: "anthropic.com",
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

export type EnvResult =
  | { mode: "create"; data: { name: string; provider: string } }
  | { mode: "select"; env: { id: string; name: string; provider: string } };

interface Props {
  onNext: (result: EnvResult) => void;
  onBack?: () => void;
  /** The agent's engine — used to filter incompatible providers (anthropic only works with claude) */
  engine?: string;
}

export function StepEnvironment({ onNext, onBack, engine }: Props) {
  const { data: envs, isLoading, isError } = useEnvironments();
  const { data: providerStatus } = useProviderStatus();
  const canUseAnthropic = engine === "claude";

  // Filter to healthy envs. Also exclude anthropic envs if engine isn't claude.
  const readyEnvs = envs?.filter(e => {
    const healthy = e.state === "ready" || e.state === "active" || e.state === "idle";
    if (!healthy) return false;
    if (e.config?.provider === "anthropic" && !canUseAnthropic) return false;
    return true;
  }) ?? [];

  // Surface unhealthy envs for debugging (user sees we have envs, they're just broken)
  const unhealthyCount = (envs?.length ?? 0) - readyEnvs.length;
  const hasExisting = !isLoading && !isError && readyEnvs.length > 0;
  const [mode, setMode] = useState<"select" | "create">("create");
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("default");
  const [provider, setProvider] = useState("");

  useEffect(() => {
    if (!isLoading) setMode(hasExisting ? "select" : "create");
  }, [isLoading, hasExisting]);

  // Auto-select first available provider (excluding anthropic if engine != claude)
  useEffect(() => {
    if (providerStatus && !provider) {
      const allProviders = [...LOCAL_PROVIDERS, ...CLOUD_PROVIDERS].filter(p =>
        p !== "anthropic" || canUseAnthropic
      );
      const first = allProviders.find(p => providerStatus[p]?.available);
      if (first) setProvider(first);
    }
  }, [providerStatus, provider, canUseAnthropic]);

  function handleContinue() {
    if (mode === "select") {
      const env = readyEnvs.find(e => e.id === selectedId);
      if (!env) { toast.error("Please select an environment"); return; }
      onNext({ mode: "select", env: { id: env.id, name: env.name, provider: env.config?.provider || "sprites" } });
    } else {
      if (!name.trim()) { toast.error("Environment name is required"); return; }
      if (!provider) { toast.error("Please select a provider"); return; }
      if (envs?.some(e => e.name.toLowerCase() === name.trim().toLowerCase())) {
        toast.error(`Environment "${name.trim()}" already exists — pick a different name or select it`);
        return;
      }
      onNext({ mode: "create", data: { name: name.trim(), provider } });
    }
  }

  if (isLoading) return null;

  if (isError) {
    return (
      <div className="w-full max-w-md flex flex-col gap-4">
        <p className="text-sm text-destructive">Failed to load environments. Check that the server is running.</p>
        <Button variant="outline" onClick={() => window.location.reload()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 2 of 4</p>
        <h2 className="text-lg font-semibold text-foreground">Choose an Environment</h2>
        <p className="text-sm text-muted-foreground mt-1">Select an existing environment or create a new one.</p>
      </div>

      {unhealthyCount > 0 && (
        <p className="text-xs text-muted-foreground rounded-md border border-amber-400/20 bg-amber-400/5 p-2">
          {unhealthyCount} existing environment{unhealthyCount > 1 ? "s are" : " is"} unavailable (unhealthy or incompatible with {engine ?? "this"} engine).
        </p>
      )}

      {hasExisting && <ModeToggle mode={mode} onModeChange={setMode} />}

      {mode === "select" && hasExisting && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Environment</Label>
            <Select value={selectedId} onValueChange={(v: string | null) => { if (v) setSelectedId(v); }}>
              <SelectTrigger className="h-10 w-full text-foreground">
                <span className="truncate">{readyEnvs.find(e => e.id === selectedId)?.name ?? "Select an environment"}</span>
              </SelectTrigger>
              <SelectContent>
                {readyEnvs.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name} <span className="text-muted-foreground ml-1">({e.config?.provider || "sprites"})</span>
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
            <Input placeholder="my-env" value={name} onChange={(e) => setName(e.target.value)} className="h-10 w-full text-foreground" />
          </div>

          <ProviderGroup label="Local" providers={LOCAL_PROVIDERS} providerStatus={providerStatus} selected={provider} onSelect={setProvider} />
          <ProviderGroup
            label="Cloud"
            providers={CLOUD_PROVIDERS.filter(p => p !== "anthropic" || canUseAnthropic)}
            providerStatus={providerStatus}
            selected={provider}
            onSelect={setProvider}
            cloud
          />
        </div>
      )}

      <div className="flex gap-2">
        {onBack && <Button variant="outline" className="h-10 px-4 text-sm" onClick={onBack}>Back</Button>}
        <Button
          className="flex-1 h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90"
          onClick={handleContinue}
          disabled={mode === "select" ? !selectedId : !name.trim() || !provider}
        >
          Continue
        </Button>
      </div>
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
                  <TooltipTrigger render={<div className="absolute top-1 left-1 rounded-full p-0.5 text-muted-foreground hover:text-foreground" onClick={(e) => e.stopPropagation()} />}>
                    <Info className="size-3" />
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
