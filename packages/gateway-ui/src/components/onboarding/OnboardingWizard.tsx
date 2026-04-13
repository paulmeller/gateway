import { useState } from "react";
import { useCreateAgent } from "@/hooks/use-agents";
import { useCreateEnvironment } from "@/hooks/use-environments";
import { useCreateVault, usePutVaultEntry } from "@/hooks/use-vaults";
import { useCreateSession } from "@/hooks/use-sessions";
import { useAppStore } from "@/stores/app-store";
import { StepAgent } from "./StepAgent";
import { StepEnvironment } from "./StepEnvironment";
import { StepSecrets } from "./StepSecrets";
import { StepReady } from "./StepReady";
import { toast } from "sonner";

export function OnboardingWizard() {
  const [step, setStep] = useState(0);
  const [agentData, setAgentData] = useState({ name: "", engine: "claude", model: "" });
  const [envData, setEnvData] = useState({ name: "", provider: "docker" });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState("");
  const [envId, setEnvId] = useState("");
  const [loading, setLoading] = useState(false);
  const createAgent = useCreateAgent();
  const createEnv = useCreateEnvironment();
  const createVault = useCreateVault();
  const putEntry = usePutVaultEntry();
  const createSession = useCreateSession();
  const setActiveSessionId = useAppStore((s) => s.setActiveSessionId);

  async function handleAgentNext(data: { name: string; engine: string; model: string }) {
    try { const agent = await createAgent.mutateAsync(data); setAgentData(data); setAgentId(agent.id); setStep(1); }
    catch { toast.error("Failed to create agent"); }
  }

  async function handleEnvNext(data: { name: string; provider: string }) {
    try { const env = await createEnv.mutateAsync({ name: data.name, config: { provider: data.provider } }); setEnvData(data); setEnvId(env.id); setStep(2); }
    catch { toast.error("Failed to create environment"); }
  }

  async function handleSecretsNext(s: Record<string, string>) { setSecrets(s); setStep(3); }

  async function handleStart() {
    setLoading(true);
    try {
      const secretEntries = Object.entries(secrets).filter(([, v]) => v.trim());
      let vaultIds: string[] = [];
      if (secretEntries.length > 0) {
        const vault = await createVault.mutateAsync({ name: "default", agent_id: agentId });
        for (const [key, value] of secretEntries) { await putEntry.mutateAsync({ vaultId: vault.id, key, value }); }
        vaultIds = [vault.id];
      }
      const session = await createSession.mutateAsync({ agent_id: agentId, environment_id: envId, vault_ids: vaultIds });
      setActiveSessionId(session.id);
    } catch { toast.error("Failed to create session"); }
    finally { setLoading(false); }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      {step === 0 && <StepAgent onNext={handleAgentNext} />}
      {step === 1 && <StepEnvironment onNext={handleEnvNext} />}
      {step === 2 && <StepSecrets engine={agentData.engine} model={agentData.model} provider={envData.provider} onNext={handleSecretsNext} onSkip={() => setStep(3)} />}
      {step === 3 && <StepReady agentName={agentData.name} envName={envData.name} hasSecrets={Object.values(secrets).some((v) => v.trim())} onStart={handleStart} loading={loading} />}
    </div>
  );
}
