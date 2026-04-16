import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

// ─── Types ────────────────────────────────────────────────────────────────

export interface KeyScope {
  agents: string[];
  environments: string[];
  vaults: string[];
}

export interface KeyPermissions {
  admin: boolean;
  scope: KeyScope | null;
}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  permissions: KeyPermissions;
  tenant_id: string | null;
  created_at: number;
}

export interface CreateKeyResponse extends ApiKeyView {
  /** Only returned on creation. Store immediately — cannot be retrieved later. */
  key: string;
}

export interface ApiKeyActivity {
  id: string;
  name: string;
  sessions: Array<{
    id: string;
    agent: { id: string; version: number };
    environment_id: string;
    status: string;
    usage_cost_usd: number;
    turn_count: number;
    created_at: string;
  }>;
  totals: {
    session_count: number;
    cost_usd: number;
    turn_count: number;
    error_count: number;
  };
}

// ─── Hooks ────────────────────────────────────────────────────────────────

export function useApiKeys() {
  return useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api<{ data: ApiKeyView[] }>("/api-keys"),
    select: (d) => d.data,
  });
}

export function useApiKeyActivity(id: string | null) {
  return useQuery({
    queryKey: ["api-keys", id, "activity"],
    queryFn: () => api<ApiKeyActivity>(`/api-keys/${id}/activity`),
    enabled: !!id,
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; permissions?: KeyPermissions; tenant_id?: string }) =>
      api<CreateKeyResponse>("/api-keys", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
}

export function useUpdateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, permissions }: { id: string; permissions: KeyPermissions }) =>
      api<ApiKeyView>(`/api-keys/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ permissions }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; id: string }>(`/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function scopeSummary(permissions: KeyPermissions): string {
  if (permissions.admin) return "admin";
  if (permissions.scope === null) return "unrestricted";
  const parts: string[] = [];
  const counts: Array<[string, string[]]> = [
    ["agents", permissions.scope.agents],
    ["envs", permissions.scope.environments],
    ["vaults", permissions.scope.vaults],
  ];
  for (const [name, list] of counts) {
    if (list.includes("*")) parts.push(`all ${name}`);
    else if (list.length > 0) parts.push(`${list.length} ${name}`);
    else parts.push(`no ${name}`);
  }
  return parts.join(" · ");
}
