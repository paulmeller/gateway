import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface ProviderStatus {
  available: boolean;
  message?: string;
}

interface ProviderStatusResponse {
  data: Record<string, ProviderStatus>;
}

export function useProviderStatus() {
  return useQuery({
    queryKey: ["provider-status"],
    queryFn: () => api<ProviderStatusResponse>("/providers/status"),
    select: (d) => d.data,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}
