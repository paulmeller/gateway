import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Server, Play, PanelRightClose, PanelRightOpen, PanelBottomClose, PanelBottomOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
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
import { isLocalModel } from "@/lib/constants";

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
  const { data: session } = useSession(sessionId);
  const createSession = useCreateSession();

  const [agentId, _setAgentId] = useState(() => localStorage.getItem("pg-agent") ?? "");
  const [environmentId, _setEnvId] = useState(() => localStorage.getItem("pg-env") ?? "");
  const [vaultId, _setVaultId] = useState(() => localStorage.getItem("pg-vault") ?? "__none__");
  const setAgentId = (v: string) => { _setAgentId(v); localStorage.setItem("pg-agent", v); };
  const setEnvironmentId = (v: string) => { _setEnvId(v); localStorage.setItem("pg-env", v); };
  const setVaultId = (v: string) => { _setVaultId(v); localStorage.setItem("pg-vault", v); };

  // Only show vaults belonging to the selected agent
  const { data: vaults } = useVaults(agentId || undefined);

  const readyEnvironments = environments?.filter(
    (e) => e.state === "ready" || e.state === "active" || e.state === "idle"
  ) ?? [];

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
  const defaultOpen = sessionId ? ["session"] : ["config"];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Accordion defaultValue={defaultOpen}>
        {/* Session section */}
        {sessionId && session && (
          <AccordionItem value="session">
            <AccordionTrigger className="px-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:no-underline">
              Session
              <StatusBadge status={session.status} />
            </AccordionTrigger>
            <AccordionContent className="px-4">
              <div className="flex flex-col gap-2">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">ID</span>
                  <code className="font-mono text-[10px] text-foreground truncate max-w-[120px]">{sessionId}</code>
                </div>
                {session.title && (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Title</span>
                    <span className="text-foreground truncate max-w-[120px]">{session.title}</span>
                  </div>
                )}
                {session.stop_reason && (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Stop reason</span>
                    <span className="font-mono text-foreground">{typeof session.stop_reason === "object" ? session.stop_reason?.type : session.stop_reason}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Created</span>
                  <span className="font-mono text-foreground">{new Date(session.created_at).toLocaleTimeString()}</span>
                </div>
                {(() => {
                  const agent = agents?.find(a => a.id === session.agent?.id);
                  const env = environments?.find(e => e.id === session.environment_id);
                  return (
                    <>
                      {agent && (
                        <>
                          <div className="flex justify-between text-xs">
                            <span className="text-muted-foreground">Model</span>
                            <span className="font-mono text-foreground truncate max-w-[120px]">{agent.model}</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-muted-foreground">Engine</span>
                            <span className="font-mono text-foreground">{(agent.engine ?? "claude") + (isLocalModel(agent.model) ? " (ollama)" : "")}</span>
                          </div>
                        </>
                      )}
                      {env?.config?.provider && (
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Provider</span>
                          <span className="font-mono text-foreground">{env.config.provider}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {/* Config section */}
        <AccordionItem value="config">
          <AccordionTrigger className="px-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:no-underline">
            {sessionId ? "New Session" : "Config"}
          </AccordionTrigger>
          <AccordionContent className="px-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Bot className="size-3" /> Agent
                </Label>
                <Select value={agentId} onValueChange={(v: string | null) => { if (v) { setAgentId(v); setVaultId("__none__"); } }}>
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
                  <div className="flex items-center gap-2 pl-0.5">
                    <span className="font-mono text-[10px] text-muted-foreground">{currentAgent.model}</span>
                    <span className="text-[10px] text-muted-foreground/60">·</span>
                    <span className="text-[10px] text-muted-foreground">{(currentAgent.engine ?? "claude") + (isLocalModel(currentAgent.model) ? " (ollama)" : "")}</span>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Server className="size-3" /> Environment
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
                {(() => {
                  const env = readyEnvironments.find(e => e.id === environmentId);
                  const provider = env?.config?.provider;
                  return provider ? (
                    <span className="text-[10px] text-muted-foreground pl-0.5">{provider}</span>
                  ) : null;
                })()}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Vault (optional)</Label>
                <Select value={vaultId} onValueChange={(v: string | null) => setVaultId(v ?? "__none__")}>
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
          </AccordionContent>
        </AccordionItem>

        {/* Skills section */}
        {sessionId && session && (
          <AccordionItem value="skills">
            <AccordionTrigger className="px-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:no-underline">
              Skills
            </AccordionTrigger>
            <AccordionContent className="px-4">
              <PlaygroundSkills agentId={session.agent?.id ?? null} />
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
    </div>
  );
}

// ─── Bottom panel: Events + Usage (IDE-style fixed height) ────────────────────

function BottomPanel({ sessionId, tab, onTabChange }: {
  sessionId: string | null;
  tab: "events" | "usage";
  onTabChange: (t: "events" | "usage") => void;
}) {
  const { data: session } = useSession(sessionId);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab bar */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-1 border-b border-border">
        <button
          className={`px-3 py-1 text-xs font-medium transition-colors rounded ${tab === "events" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => onTabChange("events")}
        >
          Events
        </button>
        <button
          className={`px-3 py-1 text-xs font-medium transition-colors rounded ${tab === "usage" ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => onTabChange("usage")}
        >
          Usage
        </button>
      </div>

      {/* Content — scrolls within fixed container */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === "events" && <EventStream />}
        {tab === "usage" && (
          <div className="p-4">
            {!sessionId ? (
              <p className="text-xs text-muted-foreground/50">No session active</p>
            ) : !session ? (
              <p className="text-xs text-muted-foreground/50">Loading…</p>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Status</span>
                  <span className="font-medium text-foreground capitalize">{session.status}</span>
                </div>
                {session.stop_reason && (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Stop reason</span>
                    <span className="font-medium text-foreground">{typeof session.stop_reason === "object" ? session.stop_reason?.type : session.stop_reason}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Title</span>
                  <span className="font-medium text-foreground truncate max-w-[200px]">{session.title ?? "—"}</span>
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
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Navbar toggles (portaled into header) ────────────────────────────────────

function NavbarToggles({ eventsOpen, filesOpen, onToggleEvents, onToggleFiles }: {
  eventsOpen: boolean;
  filesOpen: boolean;
  onToggleEvents: () => void;
  onToggleFiles: () => void;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(document.getElementById("navbar-actions"));
  }, []);
  if (!container) return null;
  return createPortal(
    <>
      <button
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${eventsOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
        onClick={onToggleEvents}
        title={eventsOpen ? "Hide events panel" : "Show events panel"}
      >
        {eventsOpen ? <PanelBottomClose className="size-3.5" /> : <PanelBottomOpen className="size-3.5" />}
        <span>Events</span>
      </button>
      <button
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${filesOpen ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
        onClick={onToggleFiles}
        title={filesOpen ? "Hide files panel" : "Show files panel"}
      >
        {filesOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
        <span>Files</span>
      </button>
    </>,
    container,
  );
}

// ─── PlaygroundPage ───────────────────────────────────────────────────────────

export function PlaygroundPage({ sessionId: initialSessionId }: { sessionId?: string }) {
  const [playgroundSessionId, setPlaygroundSessionId] = useState<string | null>(
    initialSessionId ?? null
  );
  const [filesOpen, setFilesOpen] = useState(true);
  const [eventsOpen, setEventsOpen] = useState(true);
  const [eventsTab, setEventsTab] = useState<"events" | "usage">("events");

  useEffect(() => {
    if (playgroundSessionId) {
      useAppStore.setState({ activeSessionId: playgroundSessionId });
      window.history.replaceState(null, "", `/playground/${playgroundSessionId}`);
    }
  }, [playgroundSessionId]);

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

      {/* Center panel — Chat + Events below */}
      <div className="flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden bg-background">
        {/* Chat fills remaining space */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <ChatThread />
        </div>
        <div className="shrink-0 border-t border-border">
          <ChatInput />
        </div>
        {/* Events panel — fixed 280px, does not grow */}
        {eventsOpen && (
          <div className="shrink-0 h-[280px] border-t border-border overflow-hidden">
            <BottomPanel sessionId={playgroundSessionId} tab={eventsTab} onTabChange={setEventsTab} />
          </div>
        )}
      </div>

      {/* Right panel — Output Files */}
      {filesOpen && (
        <aside className="w-72 shrink-0 border-l border-border overflow-hidden bg-background">
          <div className="flex h-full flex-col">
            <div className="shrink-0 px-4 py-3 border-b border-border">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Files
              </p>
            </div>
            <div className="flex-1 overflow-hidden">
              <PlaygroundFiles sessionId={playgroundSessionId} />
            </div>
          </div>
        </aside>
      )}

      {/* Navbar toggle buttons */}
      <NavbarToggles
        eventsOpen={eventsOpen}
        filesOpen={filesOpen}
        onToggleEvents={() => setEventsOpen(!eventsOpen)}
        onToggleFiles={() => setFilesOpen(!filesOpen)}
      />
    </div>
  );
}
