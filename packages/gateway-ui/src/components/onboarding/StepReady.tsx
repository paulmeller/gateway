import { Button } from "@/components/ui/button";

interface Props { agentName: string; envName: string; hasSecrets: boolean; onStart: () => void; loading: boolean; }

export function StepReady({ agentName, envName, hasSecrets, onStart, loading }: Props) {
  return (
    <div className="w-full max-w-md flex flex-col gap-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lime-400/60 mb-1">Step 4 of 4</p>
        <h2 className="text-lg font-semibold text-foreground">Ready to Go</h2>
        <p className="text-sm text-muted-foreground mt-1">Everything is configured. Start your first session.</p>
      </div>
      <div className="rounded-xl ring-1 ring-border bg-card p-4 flex flex-col gap-3">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Agent</span>
          <span className="font-medium text-foreground">{agentName}</span>
        </div>
        <div className="border-t border-border" />
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Environment</span>
          <span className="font-medium text-foreground">{envName}</span>
        </div>
        <div className="border-t border-border" />
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Secrets</span>
          <span className={hasSecrets ? "font-mono text-xs text-lime-400" : "text-xs text-muted-foreground"}>
            {hasSecrets ? "configured" : "skipped"}
          </span>
        </div>
      </div>
      <Button className="w-full h-10 bg-cta-gradient text-sm font-medium text-black hover:opacity-90" onClick={onStart} disabled={loading}>
        Start Chatting
      </Button>
    </div>
  );
}
