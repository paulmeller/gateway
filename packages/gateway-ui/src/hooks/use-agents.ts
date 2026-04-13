import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

interface Agent {
  id: string;
  name: string;
  model: string;
  engine: string;
  system?: string;
  tools?: unknown[];
  mcp_servers?: unknown[];
  threads_enabled?: boolean;
  confirmation_mode?: boolean;
  created_at: number;
  updated_at: number;
}

interface AgentListResponse {
  data: Agent[];
}

export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => api<AgentListResponse>("/agents?limit=50"),
    select: (d) => d.data,
  });
}

export function useAgent(id: string | null) {
  return useQuery({
    queryKey: ["agents", id],
    queryFn: () => api<Agent>(`/agents/${id}`),
    enabled: !!id,
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; engine: string; model: string }) =>
      api<Agent>("/agents", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; [key: string]: unknown }) =>
      api<Agent>(`/agents/${id}`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api(`/agents/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}
