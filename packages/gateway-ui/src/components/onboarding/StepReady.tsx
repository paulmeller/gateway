import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface Props {
  agentName: string;
  envName: string;
  secretsLabel: string;
  onStart: () => void;
  loading: boolean;
  error?: string | null;
  isExistingAgent?: boolean;
  isExistingEnv?: boolean;
}

export function StepReady({ agentName, envName, secretsLabel, onStart, loading, error, isExistingAgent, isExistingEnv }: Props) {
  return (
    <div className="w-full max-w-md flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 4 of 4</p>
        <h2 className="text-lg font-semibold text-foreground">Ready to Go</h2>
        <p className="text-sm text-muted-foreground mt-1">Everything is configured. Start your first session.</p>
      </div>

      <div className="rounded-xl ring-1 ring-border bg-card p-4 flex flex-col gap-3">
        <Row label="Agent" value={agentName} tag={isExistingAgent ? "existing" : "new"} />
        <div className="border-t border-border" />
        <Row label="Environment" value={envName} tag={isExistingEnv ? "existing" : "new"} />
        <div className="border-t border-border" />
        <Row label="Secrets" value={secretsLabel} tag={secretsLabel !== "none" ? "existing" : undefined} />
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={onStart} disabled={loading}>
        {loading ? (
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            Starting session...
          </span>
        ) : (
          "Start Session"
        )}
      </Button>
    </div>
  );
}

function Row({ label, value, tag }: { label: string; value: string; tag?: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="font-medium text-foreground">{value}</span>
        {tag && <span className="text-[10px] text-muted-foreground">({tag})</span>}
      </span>
    </div>
  );
}
