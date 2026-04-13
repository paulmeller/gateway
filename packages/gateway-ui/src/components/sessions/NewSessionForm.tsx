import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAgents } from "@/hooks/use-agents";
import { useEnvironments } from "@/hooks/use-environments";
import { useCreateSession } from "@/hooks/use-sessions";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api-client";

interface VaultListResponse { data: Array<{ id: string }>; }

export function NewSessionForm({ onCreated }: { onCreated: () => void }) {
  const { data: agents } = useAgents();
  const { data: environments } = useEnvironments();
  const create = useCreateSession();
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);
  const [agentId, setAgentId] = useState("");
  const [envId, setEnvId] = useState("");
  const readyEnvs = environments?.filter((e) => e.state === "ready") ?? [];

  async function handleCreate() {
    if (!agentId || !envId) return;
    const vaultsRes = await api<VaultListResponse>(`/vaults?agent_id=${agentId}`);
    const vaultIds = vaultsRes.data.map((v) => v.id);
    const session = await create.mutateAsync({ agent_id: agentId, environment_id: envId, vault_ids: vaultIds });
    setActiveSessionId(session.id);
    onCreated();
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <Select value={agentId} onValueChange={setAgentId}>
        <SelectTrigger className="h-8 w-full border-border bg-muted text-xs text-muted-foreground">
          <SelectValue placeholder="Agent" />
        </SelectTrigger>
        <SelectContent>
          {agents?.map((a) => <SelectItem key={a.id} value={a.id} className="text-xs">{a.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={envId} onValueChange={setEnvId}>
        <SelectTrigger className="h-8 w-full border-border bg-muted text-xs text-muted-foreground">
          <SelectValue placeholder="Environment" />
        </SelectTrigger>
        <SelectContent>
          {readyEnvs.map((e) => <SelectItem key={e.id} value={e.id} className="text-xs">{e.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        className="w-full bg-cta-gradient text-xs font-medium text-black hover:opacity-90"
        onClick={handleCreate}
        disabled={!agentId || !envId || create.isPending}
      >
        Create
      </Button>
    </div>
  );
}
