import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface ModelEntry {
  id: string;
  provider: string;
  engines: Record<string, string>;
  context_window?: number;
  local?: boolean;
}

interface ModelListResponse {
  data: ModelEntry[];
}

export function useModels(engine?: string) {
  return useQuery({
    queryKey: ["models", engine ?? "all"],
    queryFn: () =>
      api<ModelListResponse>(`/models${engine ? `?engine=${engine}` : ""}`),
    select: (d) => d.data,
    staleTime: 4 * 60 * 60 * 1000, // match server cache (4hr)
  });
}
