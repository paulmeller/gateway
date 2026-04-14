import { useState } from "react";
import { useCreateAgent } from "@/hooks/use-agents";
import { useCreateEnvironment } from "@/hooks/use-environments";
import { useCreateVault, usePutVaultEntry } from "@/hooks/use-vaults";
import { useCreateSession } from "@/hooks/use-sessions";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api-client";
import { StepAgent } from "./StepAgent";
import { StepEnvironment } from "./StepEnvironment";
import { StepSecrets } from "./StepSecrets";
import { StepReady } from "./StepReady";
import { toast } from "sonner";

interface VaultListResponse { data: Array<{ id: string; entry_count: number }> }

type AgentChoice =
  | { mode: "select"; agent: { id: string; name: string; engine: string; model: string } }
  | { mode: "create"; data: { name: string; engine: string; model: string } };

type EnvChoice =
  | { mode: "select"; env: { id: string; name: string; provider: string } }
  | { mode: "create"; data: { name: string; provider: string } };

export function OnboardingWizard() {
  const [step, setStep] = useState(0);
  const [agentChoice, setAgentChoice] = useState<AgentChoice | null>(null);
  const [envChoice, setEnvChoice] = useState<EnvChoice | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
  const [existingVaultIds, setExistingVaultIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const createAgent = useCreateAgent();
  const createEnv = useCreateEnvironment();
  const createVault = useCreateVault();
  const putEntry = usePutVaultEntry();
  const createSession = useCreateSession();
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);

  // Derived display data for later steps
  const agentData = agentChoice?.mode === "select"
    ? { name: agentChoice.agent.name, engine: agentChoice.agent.engine, model: agentChoice.agent.model }
    : agentChoice?.mode === "create"
      ? agentChoice.data
      : { name: "", engine: "claude", model: "" };

  const envData = envChoice?.mode === "select"
    ? { name: envChoice.env.name, provider: envChoice.env.provider }
    : envChoice?.mode === "create"
      ? envChoice.data
      : { name: "", provider: "docker" };

  const isExistingAgent = agentChoice?.mode === "select";
  const isExistingEnv = envChoice?.mode === "select";

  async function handleAgentNext(result: AgentChoice) {
    setAgentChoice(result);
    if (result.mode === "select") {
      // Check for existing vaults on selected agent
      try {
        const res = await api<VaultListResponse>(`/vaults?agent_id=${result.agent.id}`);
        const ids = res.data.filter(v => v.entry_count > 0).map(v => v.id);
        setExistingVaultIds(ids);
      } catch { /* ignore */ }
    } else {
      setExistingVaultIds([]);
    }
    setStep(1);
  }

  function handleEnvNext(result: EnvChoice) {
    setEnvChoice(result);
    setStep(2);
  }

  function handleSecretsNext(s: Record<string, string>) {
    setSecrets(s);
    setSelectedVaultId(null);
    setStep(3);
  }

  function handleSelectVault(vaultId: string) {
    setSelectedVaultId(vaultId);
    setSecrets({});
    setStep(3);
  }

  async function handleStart() {
    if (!agentChoice || !envChoice) return;
    setLoading(true);
    try {
      // 1. Create or resolve agent
      let agentId: string;
      if (agentChoice.mode === "select") {
        agentId = agentChoice.agent.id;
      } else {
        const agent = await createAgent.mutateAsync(agentChoice.data);
        agentId = agent.id;
      }

      // 2. Create or resolve environment
      let envId: string;
      if (envChoice.mode === "select") {
        envId = envChoice.env.id;
      } else {
        const env = await createEnv.mutateAsync({
          name: envChoice.data.name,
          config: { provider: envChoice.data.provider },
        });
        envId = env.id;
      }

      // 3. Resolve vault — from selection, new secrets, or existing agent vaults
      let vaultIds = [...existingVaultIds];

      if (selectedVaultId) {
        // User picked an existing vault from the picker
        vaultIds = [selectedVaultId];
      } else {
        const secretEntries = Object.entries(secrets).filter(([, v]) => v.trim());
        if (secretEntries.length > 0) {
          if (existingVaultIds.length > 0) {
            const vaultId = existingVaultIds[0];
            for (const [key, value] of secretEntries) {
              await putEntry.mutateAsync({ vaultId, key, value });
            }
          } else {
            const vault = await createVault.mutateAsync({ name: "default", agent_id: agentId });
            for (const [key, value] of secretEntries) {
              await putEntry.mutateAsync({ vaultId: vault.id, key, value });
            }
            vaultIds = [vault.id];
          }
        }
      }

      // 4. Create session
      const session = await createSession.mutateAsync({
        agent_id: agentId,
        environment_id: envId,
        vault_ids: vaultIds.length > 0 ? vaultIds : undefined,
      });
      setActiveSessionId(session.id);
    } catch (err: unknown) {
      const msg = (err as { body?: { error?: { message?: string } } })?.body?.error?.message
        || (err instanceof Error ? err.message : "Failed to start session");
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      {step === 0 && <StepAgent onNext={handleAgentNext} />}
      {step === 1 && <StepEnvironment onNext={handleEnvNext} />}
      {step === 2 && <StepSecrets engine={agentData.engine} model={agentData.model} provider={envData.provider} hasExistingVaults={existingVaultIds.length > 0} onNext={handleSecretsNext} onSkip={() => setStep(3)} onSelectVault={handleSelectVault} />}
      {step === 3 && <StepReady agentName={agentData.name} envName={envData.name} hasSecrets={Object.values(secrets).some((v) => v.trim()) || existingVaultIds.length > 0 || !!selectedVaultId} onStart={handleStart} loading={loading} isExistingAgent={isExistingAgent} isExistingEnv={isExistingEnv} />}
    </div>
  );
}
