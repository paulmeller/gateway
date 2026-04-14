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

export function OnboardingWizard() {
  const [step, setStep] = useState(0);
  const [agentData, setAgentData] = useState({ name: "", engine: "claude", model: "" });
  const [envData, setEnvData] = useState({ name: "", provider: "docker" });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState("");
  const [envId, setEnvId] = useState("");
  const [existingVaultIds, setExistingVaultIds] = useState<string[]>([]);
  const [isExistingAgent, setIsExistingAgent] = useState(false);
  const [isExistingEnv, setIsExistingEnv] = useState(false);
  const [loading, setLoading] = useState(false);
  const createAgent = useCreateAgent();
  const createEnv = useCreateEnvironment();
  const createVault = useCreateVault();
  const putEntry = usePutVaultEntry();
  const createSession = useCreateSession();
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);

  async function handleAgentNext(result: { mode: "select"; agent: { id: string; name: string; engine: string; model: string } } | { mode: "create"; data: { name: string; engine: string; model: string } }) {
    if (result.mode === "select") {
      const { agent } = result;
      setAgentId(agent.id);
      setAgentData({ name: agent.name, engine: agent.engine, model: agent.model });
      setIsExistingAgent(true);
      // Check for existing vaults
      try {
        const res = await api<VaultListResponse>(`/vaults?agent_id=${agent.id}`);
        const ids = res.data.filter(v => v.entry_count > 0).map(v => v.id);
        setExistingVaultIds(ids);
      } catch { /* ignore */ }
      setStep(1);
    } else {
      try {
        const agent = await createAgent.mutateAsync(result.data);
        setAgentData(result.data);
        setAgentId(agent.id);
        setIsExistingAgent(false);
        setExistingVaultIds([]);
        setStep(1);
      } catch {
        toast.error("Failed to create agent");
      }
    }
  }

  async function handleEnvNext(result: { mode: "select"; env: { id: string; name: string; provider: string } } | { mode: "create"; data: { name: string; provider: string } }) {
    if (result.mode === "select") {
      const { env } = result;
      setEnvId(env.id);
      setEnvData({ name: env.name, provider: env.provider });
      setIsExistingEnv(true);
      setStep(2);
    } else {
      try {
        const env = await createEnv.mutateAsync({ name: result.data.name, config: { provider: result.data.provider } });
        setEnvData(result.data);
        setEnvId(env.id);
        setIsExistingEnv(false);
        setStep(2);
      } catch {
        toast.error("Failed to create environment");
      }
    }
  }

  async function handleSecretsNext(s: Record<string, string>) { setSecrets(s); setStep(3); }

  async function handleStart() {
    setLoading(true);
    try {
      const secretEntries = Object.entries(secrets).filter(([, v]) => v.trim());
      let vaultIds = [...existingVaultIds];

      if (secretEntries.length > 0) {
        if (existingVaultIds.length > 0) {
          // Add new entries to existing vault
          const vaultId = existingVaultIds[0];
          for (const [key, value] of secretEntries) {
            await putEntry.mutateAsync({ vaultId, key, value });
          }
        } else {
          // Create new vault
          const vault = await createVault.mutateAsync({ name: "default", agent_id: agentId });
          for (const [key, value] of secretEntries) {
            await putEntry.mutateAsync({ vaultId: vault.id, key, value });
          }
          vaultIds = [vault.id];
        }
      }

      const session = await createSession.mutateAsync({
        agent_id: agentId,
        environment_id: envId,
        vault_ids: vaultIds.length > 0 ? vaultIds : undefined,
      });
      setActiveSessionId(session.id);
    } catch {
      toast.error("Failed to create session");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      {step === 0 && <StepAgent onNext={handleAgentNext} />}
      {step === 1 && <StepEnvironment onNext={handleEnvNext} />}
      {step === 2 && <StepSecrets engine={agentData.engine} model={agentData.model} provider={envData.provider} hasExistingVaults={existingVaultIds.length > 0} onNext={handleSecretsNext} onSkip={() => setStep(3)} />}
      {step === 3 && <StepReady agentName={agentData.name} envName={envData.name} hasSecrets={Object.values(secrets).some((v) => v.trim()) || existingVaultIds.length > 0} onStart={handleStart} loading={loading} isExistingAgent={isExistingAgent} isExistingEnv={isExistingEnv} />}
    </div>
  );
}
