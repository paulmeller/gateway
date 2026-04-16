import { useEffect, useState } from "react";
import { Bot, Server, Play, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { useAgents } from "@/hooks/use-agents";
import { useEnvironments } from "@/hooks/use-environments";
import { useVaults } from "@/hooks/use-vaults";
import { useCreateSession, useSession } from "@/hooks/use-sessions";
import { useAppStore } from "@/stores/app-store";
import { ChatThread } from "@/components/chat/ChatThread";
import { ChatInput } from "@/components/chat/ChatInput";
import { EventStream } from "@/components/events/EventStream";
import { PlaygroundSkills } from "@/components/playground/PlaygroundSkills";
import { PlaygroundFiles } from "@/components/playground/PlaygroundFiles";
import { toast } from "sonner";

// ─── Left panel ───────────────────────────────────────────────────────────────

interface ConfigPanelProps {
  sessionId: string | null;
  onSessionCreated: (id: string) => void;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "running" || status === "active") {
    return <Badge variant="outline" className="border-lime-400/20 bg-lime-400/10 text-lime-400 text-xs">{status}</Badge>;
  }
  if (status === "error" || status === "failed") {
    return <Badge variant="outline" className="border-red-400/20 bg-red-400/10 text-red-400 text-xs">{status}</Badge>;
  }
  return <Badge variant="outline" className="text-muted-foreground text-xs">{status}</Badge>;
}

function ConfigPanel({ sessionId, onSessionCreated }: ConfigPanelProps) {
  const { data: agents } = useAgents();
  const { data: environments } = useEnvironments();
  const { data: vaults } = useVaults();
  const { data: session } = useSession(sessionId);
  const createSession = useCreateSession();

  const readyEnvironments = environments?.filter(
    (e) => e.state === "ready" || e.state === "active" || e.state === "idle"
  ) ?? [];

  // Pre-fill from current session or default to first available
  const [agentId, setAgentId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [vaultId, setVaultId] = useState("__none__");

  // Sync dropdowns when session data or resource lists load
  useEffect(() => {
    if (session && agents) {
      const sid = session.agent?.id;
      if (sid && agents.some(a => a.id === sid)) setAgentId(sid);
    } else if (agents?.length && !agentId) {
      setAgentId(agents[0].id);
    }
  }, [session, agents]);

  useEffect(() => {
    if (session && readyEnvironments.length) {
      const eid = session.environment_id;
      if (eid && readyEnvironments.some(e => e.id === eid)) setEnvironmentId(eid);
    } else if (readyEnvironments.length && !environmentId) {
      setEnvironmentId(readyEnvironments[0].id);
    }
  }, [session, environments]);

  useEffect(() => {
    if (session?.vault_ids?.length && vaults) {
      const vid = session.vault_ids[0];
      if (vaults.some(v => v.id === vid)) setVaultId(vid);
    }
  }, [session, vaults]);

  async function handleStart() {
    if (!agentId || !environmentId) return;
    try {
      const vault_ids = vaultId && vaultId !== "__none__" ? [vaultId] : undefined;
      const result = await createSession.mutateAsync({
        agent_id: agentId,
        environment_id: environmentId,
        vault_ids,
      });
      onSessionCreated(result.id);
    } catch (err: unknown) {
      const msg = (err as { body?: { error?: { message?: string } } })?.body?.error?.message
        || (err instanceof Error ? err.message : "Failed to create session");
      toast.error(msg);
    }
  }

  const currentAgent = agents?.find(a => a.id === agentId);

  return (
    <div className="flex h-full flex-col">
      {/* Current session info */}
      {sessionId && session && (
        <div className="flex flex-col gap-3 border-b border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Current Session
          </p>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <code className="font-mono text-[10px] text-muted-foreground truncate max-w-[140px]">
                {sessionId}
              </code>
              <StatusBadge status={session.status} />
            </div>
          </div>
        </div>
      )}

      {/* Quick-switch config — collapsible */}
      <Collapsible defaultOpen={!sessionId}>
        <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
          {sessionId ? "New Session" : "Config"}
          <ChevronDown className="size-3.5 transition-transform data-[panel-open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 px-4 pb-4">
            <div className="flex flex-col gap-1.5">
              <Label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                <Bot className="size-3" />
                Agent
              </Label>
              <Select value={agentId} onValueChange={(v: string | null) => { if (v) setAgentId(v); }}>
                <SelectTrigger className="h-8 w-full text-xs text-foreground">
                  <span className="truncate">{currentAgent?.name ?? "Select agent…"}</span>
                </SelectTrigger>
                <SelectContent>
                  {agents?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {currentAgent && (
                <span className="font-mono text-[10px] text-muted-foreground pl-0.5">
                  {currentAgent.model}
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                <Server className="size-3" />
                Environment
              </Label>
              <Select value={environmentId} onValueChange={(v: string | null) => { if (v) setEnvironmentId(v); }}>
                <SelectTrigger className="h-8 w-full text-xs text-foreground">
                  <span className="truncate">{readyEnvironments.find(e => e.id === environmentId)?.name ?? "Select environment…"}</span>
                </SelectTrigger>
                <SelectContent>
                  {readyEnvironments.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                  ))}
                  {!readyEnvironments.length && (
                    <SelectItem value="__none__" disabled>No environments</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Vault (optional)
              </Label>
              <Select
                value={vaultId}
                onValueChange={(v: string | null) => setVaultId(v ?? "__none__")}
              >
                <SelectTrigger className="h-8 w-full text-xs text-foreground">
                  <span className="truncate">{vaultId === "__none__" ? "None" : vaults?.find(v => v.id === vaultId)?.name ?? "None"}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {vaults?.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button
              className="w-full h-8 bg-cta-gradient text-xs font-medium text-black hover:opacity-90 disabled:opacity-40"
              disabled={!agentId || !environmentId || createSession.isPending}
              onClick={handleStart}
            >
              <Play className="size-3 mr-1" />
              {createSession.isPending ? "Starting…" : sessionId ? "Start New Session" : "Start Session"}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Skills & Files — only when session is active */}
      {sessionId && session && (
        <>
          <PlaygroundSkills agentId={session.agent?.id ?? null} />
          <PlaygroundFiles sessionId={sessionId} />
        </>
      )}
    </div>
  );
}

// ─── Right panel: Inspector ───────────────────────────────────────────────────

interface InspectorPanelProps {
  sessionId: string | null;
}

function InspectorPanel({ sessionId }: InspectorPanelProps) {
  const { data: session } = useSession(sessionId);
  const [tab, setTab] = useState<"events" | "usage">("events");

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-4 py-3">
        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${tab === "events" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setTab("events")}
          >
            Events
          </button>
          <button
            className={`flex-1 px-3 py-1.5 text-sm font-medium transition-colors ${tab === "usage" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => setTab("usage")}
          >
            Usage
          </button>
        </div>
      </div>

      {tab === "events" && (
        <div className="flex-1 overflow-y-auto">
          <EventStream />
        </div>
      )}

      {tab === "usage" && (
        <div className="flex-1 overflow-y-auto p-4">
          {!sessionId ? (
            <p className="text-xs text-muted-foreground/50">No session active</p>
          ) : !session ? (
            <p className="text-xs text-muted-foreground/50">Loading…</p>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Session Usage
              </p>
              <div className="flex flex-col gap-2">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Status</span>
                  <span className="font-medium text-foreground capitalize">{session.status}</span>
                </div>
                {session.stop_reason && (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Stop reason</span>
                    <span className="font-medium text-foreground">{session.stop_reason}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Title</span>
                  <span className="font-medium text-foreground truncate max-w-[120px]">{session.title ?? "—"}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Created</span>
                  <span className="font-mono text-foreground">{new Date(session.created_at).toLocaleTimeString()}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Updated</span>
                  <span className="font-mono text-foreground">{new Date(session.updated_at).toLocaleTimeString()}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── PlaygroundPage ───────────────────────────────────────────────────────────

export function PlaygroundPage({ sessionId: initialSessionId }: { sessionId?: string }) {
  const [playgroundSessionId, setPlaygroundSessionId] = useState<string | null>(
    initialSessionId ?? null
  );

  // Keep the store in sync so ChatThread/ChatInput work
  useEffect(() => {
    if (playgroundSessionId) {
      useAppStore.setState({ activeSessionId: playgroundSessionId });
      window.history.replaceState(null, "", `/playground/${playgroundSessionId}`);
    }
  }, [playgroundSessionId]);

  // Clear activeSessionId on unmount so we don't leave stale state
  useEffect(() => {
    return () => {
      useAppStore.setState({ activeSessionId: null });
    };
  }, []);

  function handleSessionCreated(id: string) {
    setPlaygroundSessionId(id);
  }

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left panel — Config */}
      <aside className="w-64 shrink-0 border-r border-border overflow-y-auto bg-background">
        <ConfigPanel
          sessionId={playgroundSessionId}
          onSessionCreated={handleSessionCreated}
        />
      </aside>

      {/* Center panel — Chat: thread scrolls, input pinned to bottom */}
      <div className="flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden bg-background">
        <ChatThread />
        <div className="shrink-0 border-t border-border">
          <ChatInput />
        </div>
      </div>

      {/* Right panel — Inspector */}
      <aside className="w-72 shrink-0 border-l border-border overflow-hidden bg-background">
        <InspectorPanel sessionId={playgroundSessionId} />
      </aside>
    </div>
  );
}
