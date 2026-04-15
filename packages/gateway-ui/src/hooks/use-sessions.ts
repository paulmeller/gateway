import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface Session {
  id: string;
  agent: { id: string; version: number };
  environment_id: string;
  vault_ids?: string[];
  status: string;
  stop_reason: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface SessionListResponse {
  data: Session[];
}

export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: () => api<SessionListResponse>("/sessions?limit=50&order=desc"),
    select: (d) => d.data,
  });
}

export function useSession(id: string | null) {
  return useQuery({
    queryKey: ["sessions", id],
    queryFn: () => api<Session>(`/sessions/${id}`),
    enabled: !!id,
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agent_id, environment_id, vault_ids }: { agent_id: string; environment_id: string; vault_ids?: string[] }) =>
      api<Session>("/sessions", { method: "POST", body: JSON.stringify({ agent: agent_id, environment_id, vault_ids }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

export function useArchiveSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api(`/sessions/${id}/archive`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api(`/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
}
