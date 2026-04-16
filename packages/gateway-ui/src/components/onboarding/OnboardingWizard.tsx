import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useCreateAgent } from "@/hooks/use-agents";
import { useCreateEnvironment } from "@/hooks/use-environments";
import { useCreateVault, usePutVaultEntry } from "@/hooks/use-vaults";
import { useCreateSession } from "@/hooks/use-sessions";
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
  const [selectedVault, setSelectedVault] = useState<{ id: string; name: string } | null>(null);
  const [existingVaultIds, setExistingVaultIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track partial-failure state: if we created an agent/env then failed, reuse the IDs on retry
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [createdEnvId, setCreatedEnvId] = useState<string | null>(null);
  const createAgent = useCreateAgent();
  const createEnv = useCreateEnvironment();
  const createVault = useCreateVault();
  const putEntry = usePutVaultEntry();
  const createSession = useCreateSession();
  const navigate = useNavigate();

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
    setSelectedVault(null);
    setStep(3);
  }

  function handleSelectVault(vaultId: string, vaultName: string) {
    setSelectedVault({ id: vaultId, name: vaultName });
    setSecrets({});
    setStep(3);
  }

  async function handleStart() {
    if (!agentChoice || !envChoice) return;
    setLoading(true);
    setError(null);
    try {
      // 1. Create or resolve agent (reuse from previous failed attempt if present)
      let agentId: string;
      if (agentChoice.mode === "select") {
        agentId = agentChoice.agent.id;
      } else if (createdAgentId) {
        agentId = createdAgentId; // Retry — don't re-create
      } else {
        const agent = await createAgent.mutateAsync(agentChoice.data);
        agentId = agent.id;
        setCreatedAgentId(agent.id);
      }

      // 2. Create or resolve environment (reuse from previous failed attempt if present)
      let envId: string;
      if (envChoice.mode === "select") {
        envId = envChoice.env.id;
      } else if (createdEnvId) {
        envId = createdEnvId;
      } else {
        const env = await createEnv.mutateAsync({
          name: envChoice.data.name,
          config: { provider: envChoice.data.provider },
        });
        envId = env.id;
        setCreatedEnvId(env.id);
      }

      // 3. Resolve vault — from selection, new secrets, or existing agent vaults
      let vaultIds = [...existingVaultIds];

      if (selectedVault) {
        // User picked an existing vault from the picker
        vaultIds = [selectedVault.id];
      } else {
        // Auto-detect sk-ant-oat OAuth tokens and remap to CLAUDE_CODE_OAUTH_TOKEN.
        // Store trimmed values — whitespace from paste breaks runtime auth.
        const isAnthropicProvider = envData.provider === "anthropic";
        const secretEntries = Object.entries(secrets)
          .map(([key, rawValue]) => [key, rawValue.trim()] as [string, string])
          .filter(([, v]) => v.length > 0)
          .map(([key, value]) => {
            const isOauth = value.startsWith("sk-ant-oat");
            if (isOauth && isAnthropicProvider) {
              throw new Error(
                "OAuth tokens (sk-ant-oat) are not supported with the Anthropic provider. Use a regular API key (sk-ant-api03-...) instead.",
              );
            }
            if (key === "ANTHROPIC_API_KEY" && isOauth) {
              return ["CLAUDE_CODE_OAUTH_TOKEN", value] as [string, string];
            }
            return [key, value] as [string, string];
          });
        if (secretEntries.length > 0) {
          // Find or create a vault for this agent
          let vaultId: string;
          if (existingVaultIds.length > 0) {
            vaultId = existingVaultIds[0];
          } else {
            // Check if agent already has a "default" vault from a previous run
            try {
              const res = await api<{ data: Array<{ id: string; name: string }> }>(`/vaults?agent_id=${agentId}`);
              const existing = res.data.find(v => v.name === "my-vault");
              if (existing) {
                vaultId = existing.id;
              } else {
                const vault = await createVault.mutateAsync({ name: "my-vault", agent_id: agentId });
                vaultId = vault.id;
              }
            } catch {
              const vault = await createVault.mutateAsync({ name: `vault-${Date.now()}`, agent_id: agentId });
              vaultId = vault.id;
            }
          }
          for (const [key, value] of secretEntries) {
            await putEntry.mutateAsync({ vaultId, key, value });
          }
          vaultIds = [vaultId];
        }
      }

      // 4. Create session
      const session = await createSession.mutateAsync({
        agent_id: agentId,
        environment_id: envId,
        vault_ids: vaultIds.length > 0 ? vaultIds : undefined,
      });

      // One-time first-session toast
      const firstSessionKey = "as.first_session_shown";
      if (!localStorage.getItem(firstSessionKey)) {
        localStorage.setItem(firstSessionKey, "1");
        toast.success("Session started — try saying 'hi' in the chat.");
      }

      navigate({ to: "/playground/$sessionId", params: { sessionId: session.id } });
    } catch (err: unknown) {
      const msg = (err as { body?: { error?: { message?: string } } })?.body?.error?.message
        || (err instanceof Error ? err.message : "Failed to start session");
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  function getSecretsLabel(): string {
    if (selectedVault) return selectedVault.name;
    if (existingVaultIds.length > 0) return "agent vault";
    const keys = Object.entries(secrets).filter(([, v]) => v.trim());
    if (keys.length > 0) return `${keys.length} key${keys.length > 1 ? "s" : ""}`;
    return "none";
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      {step === 0 && <StepAgent onNext={handleAgentNext} />}
      {step === 1 && <StepEnvironment onNext={handleEnvNext} onBack={() => setStep(0)} engine={agentData.engine} />}
      {step === 2 && <StepSecrets engine={agentData.engine} model={agentData.model} provider={envData.provider} agentId={agentChoice?.mode === "select" ? agentChoice.agent.id : null} hasExistingVaults={existingVaultIds.length > 0} onNext={handleSecretsNext} onSkip={() => setStep(3)} onSelectVault={handleSelectVault} onBack={() => setStep(1)} />}
      {step === 3 && <StepReady agentName={agentData.name} envName={envData.name} secretsLabel={getSecretsLabel()} onStart={handleStart} loading={loading} error={error} isExistingAgent={isExistingAgent} isExistingEnv={isExistingEnv} onBack={() => setStep(2)} />}
    </div>
  );
}
