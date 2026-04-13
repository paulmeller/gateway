import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

interface MemoryStore {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

interface Memory {
  id: string;
  path: string;
  content: string;
  content_sha256: string;
  created_at: string;
  updated_at: string;
}

interface MemoryStoreListResponse { data: MemoryStore[]; }
interface MemoryListResponse { data: Memory[]; }

export function useMemoryStores() {
  return useQuery({
    queryKey: ["memory-stores"],
    queryFn: () => api<MemoryStoreListResponse>("/memory_stores?limit=50"),
    select: (d) => d.data,
  });
}

export function useCreateMemoryStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string }) =>
      api<MemoryStore>("/memory_stores", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memory-stores"] }),
  });
}

export function useDeleteMemoryStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/memory_stores/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memory-stores"] }),
  });
}

export function useMemories(storeId: string | null) {
  return useQuery({
    queryKey: ["memory-stores", storeId, "memories"],
    queryFn: () => api<MemoryListResponse>(`/memory_stores/${storeId}/memories?limit=100`),
    enabled: !!storeId,
    select: (d) => d.data,
  });
}

export function useCreateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ storeId, path, content }: { storeId: string; path: string; content: string }) =>
      api<Memory>(`/memory_stores/${storeId}/memories`, { method: "POST", body: JSON.stringify({ path, content }) }),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["memory-stores", vars.storeId, "memories"] }),
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ storeId, memoryId }: { storeId: string; memoryId: string }) =>
      api(`/memory_stores/${storeId}/memories/${memoryId}`, { method: "DELETE" }),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["memory-stores", vars.storeId, "memories"] }),
  });
}
