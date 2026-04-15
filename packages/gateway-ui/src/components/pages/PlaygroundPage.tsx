import { useEffect, useState } from "react";
import { Bot, Server, Lock, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAgents } from "@/hooks/use-agents";
import { useEnvironments } from "@/hooks/use-environments";
import { useVaults } from "@/hooks/use-vaults";
import { useCreateSession, useSession } from "@/hooks/use-sessions";
import { useAppStore } from "@/stores/app-store";
import { ChatThread } from "@/components/chat/ChatThread";
import { ChatInput } from "@/components/chat/ChatInput";
import { EventStream } from "@/components/events/EventStream";

// ─── Left panel ───────────────────────────────────────────────────────────────

interface ConfigPanelProps {
  sessionId: string | null;
  onSessionCreated: (id: string) => void;
}

function ConfigPanel({ sessionId, onSessionCreated }: ConfigPanelProps) {
  const { data: agents } = useAgents();
  const { data: environments } = useEnvironments();
  const { data: vaults } = useVaults();
  const createSession = useCreateSession();
  const { data: session } = useSession(sessionId);

  const [agentId, setAgentId] = useState<string>("");
  const [environmentId, setEnvironmentId] = useState<string>("");
  const [vaultId, setVaultId] = useState<string>("");

  const selectedAgent = agents?.find((a) => a.id === agentId);
  const readyEnvironments = environments?.filter(
    (e) => e.state === "ready" || e.state === "active" || e.state === "idle"
  ) ?? [];

  async function handleStart() {
    if (!agentId || !environmentId) return;
    const vault_ids = vaultId ? [vaultId] : undefined;
    const result = await createSession.mutateAsync({
      agent_id: agentId,
      environment_id: environmentId,
      vault_ids,
    });
    onSessionCreated(result.id);
  }

  // ── Session info view ──────────────────────────────────────────────────────
  if (sessionId && session) {
    const agent = agents?.find((a) => a.id === session.agent?.id);
    const env = environments?.find((e) => e.id === session.environment_id);

    return (
      <div className="flex flex-col gap-4 p-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Session
        </p>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Session ID
            </span>
            <code className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground break-all">
              {sessionId.slice(0, 20)}…
            </code>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Status
            </span>
            <div>
              {session.status === "running" || session.status === "active" ? (
                <Badge
                  variant="outline"
                  className="border-lime-400/20 bg-lime-400/10 text-lime-400 text-xs"
                >
                  {session.status}
                </Badge>
              ) : session.status === "error" || session.status === "failed" ? (
                <Badge
                  variant="outline"
                  className="border-red-400/20 bg-red-400/10 text-red-400 text-xs"
                >
                  {session.status}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="text-muted-foreground text-xs"
                >
                  {session.status}
                </Badge>
              )}
            </div>
          </div>

          {agent && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Agent
              </span>
              <div className="flex items-center gap-1.5">
                <Bot className="size-3.5 text-muted-foreground" />
                <span className="text-sm text-foreground">{agent.name}</span>
              </div>
              <span className="font-mono text-xs text-muted-foreground">
                {agent.model}
              </span>
            </div>
          )}

          {env && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Environment
              </span>
              <div className="flex items-center gap-1.5">
                <Server className="size-3.5 text-muted-foreground" />
                <span className="text-sm text-foreground">{env.name}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Creation form view ─────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        Agent Config
      </p>

      {/* Agent selector */}
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Bot className="size-3.5" />
          Agent
        </label>
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger className="w-full text-foreground">
            <SelectValue placeholder="Select agent…" />
          </SelectTrigger>
          <SelectContent>
            {agents?.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
            {!agents?.length && (
              <SelectItem value="__none__" disabled>
                No agents found
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      {/* Model display */}
      {selectedAgent && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Model
          </span>
          <span className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
            {selectedAgent.model}
          </span>
        </div>
      )}

      {/* Environment selector */}
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Server className="size-3.5" />
          Environment
        </label>
        <Select value={environmentId} onValueChange={setEnvironmentId}>
          <SelectTrigger className="w-full text-foreground">
            <SelectValue placeholder="Select environment…" />
          </SelectTrigger>
          <SelectContent>
            {readyEnvironments.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
            {environments && environments.length > 0 && readyEnvironments.length === 0 && (
              <SelectItem value="__none__" disabled>
                No ready environments
              </SelectItem>
            )}
            {!environments?.length && (
              <SelectItem value="__none__" disabled>
                No environments found
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      {/* Vault selector */}
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5" />
          Vault (optional)
        </label>
        <Select value={vaultId} onValueChange={setVaultId}>
          <SelectTrigger className="w-full text-foreground">
            <SelectValue placeholder="None" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">None</SelectItem>
            {vaults?.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Start button */}
      <Button
        className="mt-2 w-full bg-cta-gradient text-black hover:opacity-90 disabled:opacity-40"
        disabled={!agentId || !environmentId || createSession.isPending}
        onClick={handleStart}
      >
        <Play className="size-3.5 mr-1.5" />
        {createSession.isPending ? "Starting…" : "Start Session"}
      </Button>

      {createSession.isError && (
        <p className="text-xs text-destructive">
          Failed to create session. Please try again.
        </p>
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

  return (
    <Tabs defaultValue="events" className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-3 pt-2">
        <TabsList className="h-8">
          <TabsTrigger value="events" className="text-xs px-3">
            Events
          </TabsTrigger>
          <TabsTrigger value="usage" className="text-xs px-3">
            Usage
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="events" className="flex-1 overflow-hidden m-0 p-0">
        <div className="h-full overflow-y-auto">
          <EventStream />
        </div>
      </TabsContent>

      <TabsContent value="usage" className="flex-1 overflow-y-auto m-0 p-4">
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
                <span className="font-medium text-foreground capitalize">
                  {session.status}
                </span>
              </div>
              {session.stop_reason && (
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Stop reason</span>
                  <span className="font-medium text-foreground">
                    {session.stop_reason}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Title</span>
                <span className="font-medium text-foreground truncate max-w-[120px]">
                  {session.title ?? "—"}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Created</span>
                <span className="font-mono text-foreground">
                  {new Date(session.created_at).toLocaleTimeString()}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Updated</span>
                <span className="font-mono text-foreground">
                  {new Date(session.updated_at).toLocaleTimeString()}
                </span>
              </div>
            </div>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

// ─── PlaygroundPage ───────────────────────────────────────────────────────────

export function PlaygroundPage() {
  const [playgroundSessionId, setPlaygroundSessionId] = useState<string | null>(
    null
  );
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);

  // Keep the store in sync so ChatThread/ChatInput work
  useEffect(() => {
    if (playgroundSessionId) {
      // Update store directly without triggering the history.pushState side-effect
      useAppStore.setState({ activeSessionId: playgroundSessionId });
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
    <div className="flex h-full overflow-hidden">
      {/* Left panel — Agent Config */}
      <aside className="w-64 shrink-0 border-r border-border overflow-y-auto bg-background">
        <ConfigPanel
          sessionId={playgroundSessionId}
          onSessionCreated={handleSessionCreated}
        />
      </aside>

      {/* Center panel — Chat */}
      <div className="flex flex-1 flex-col overflow-hidden bg-background">
        <ChatThread />
        <ChatInput />
      </div>

      {/* Right panel — Inspector */}
      <aside className="w-72 shrink-0 border-l border-border overflow-hidden bg-background">
        <InspectorPanel sessionId={playgroundSessionId} />
      </aside>
    </div>
  );
}
