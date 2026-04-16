import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

interface Vault {
  id: string;
  name: string;
  agent_id: string;
  entry_count: number;
  created_at: number;
}

interface VaultEntry {
  key: string;
  value: string;
}

interface VaultListResponse {
  data: Vault[];
}

interface VaultEntriesResponse {
  data: VaultEntry[];
}

export function useVaults(agentId?: string) {
  const path = agentId ? `/vaults?agent_id=${agentId}&limit=50` : "/vaults?limit=50";
  return useQuery({
    queryKey: ["vaults", agentId ?? "all"],
    queryFn: () => api<VaultListResponse>(path),
    select: (d) => d.data,
  });
}

export function useVaultEntries(vaultId: string | null) {
  return useQuery({
    queryKey: ["vaults", vaultId, "entries"],
    queryFn: () => api<VaultEntriesResponse>(`/vaults/${vaultId}/entries`),
    enabled: !!vaultId,
    select: (d) => d.data,
  });
}

export function useCreateVault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; agent_id: string }) =>
      api<Vault>("/vaults", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vaults"] }),
  });
}

export function useDeleteVault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api(`/vaults/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vaults"] }),
  });
}

export function usePutVaultEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ vaultId, key, value }: { vaultId: string; key: string; value: string }) =>
      api(`/vaults/${vaultId}/entries/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["vaults", vars.vaultId, "entries"] }),
  });
}

export function useDeleteVaultEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ vaultId, key }: { vaultId: string; key: string }) =>
      api(`/vaults/${vaultId}/entries/${key}`, { method: "DELETE" }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["vaults", vars.vaultId, "entries"] }),
  });
}
