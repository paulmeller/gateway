import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

interface SavedRepo {
  url: string;
  branch: string;
  added_at: string;
}

export function useRepositories() {
  return useQuery({
    queryKey: ["saved-repositories"],
    queryFn: async () => {
      const res = await api<{ key: string; value: string | null }>("/settings/saved_repositories");
      if (!res.value) return [];
      try { return JSON.parse(res.value) as SavedRepo[]; } catch { return []; }
    },
  });
}

export function useSaveRepositories() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (repos: SavedRepo[]) => {
      await api("/settings", {
        method: "PUT",
        body: JSON.stringify({ key: "saved_repositories", value: JSON.stringify(repos) }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-repositories"] }),
  });
}
