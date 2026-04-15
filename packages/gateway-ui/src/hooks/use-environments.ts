import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

interface Environment {
  id: string;
  name: string;
  state: string;
  config: { provider?: string; [key: string]: unknown };
  created_at: number;
  updated_at: number;
}

interface EnvironmentListResponse {
  data: Environment[];
}

export function useEnvironments() {
  return useQuery({
    queryKey: ["environments"],
    queryFn: () => api<EnvironmentListResponse>("/environments?limit=50"),
    select: (d) => d.data,
  });
}

export function useCreateEnvironment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, config }: { name: string; config?: { provider?: string } }) =>
      api<Environment>("/environments", {
        method: "POST",
        body: JSON.stringify({ name, config: { type: "cloud", provider: config?.provider, packages: {} } }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["environments"] }),
  });
}

export function useDeleteEnvironment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api(`/environments/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["environments"] }),
  });
}
