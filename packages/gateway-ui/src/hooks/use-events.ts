import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface SessionEvent {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  processed_at: string | null;
  [key: string]: unknown;
}

interface EventListResponse {
  data: SessionEvent[];
}

export function useEvents(sessionId: string | null) {
  return useQuery({
    queryKey: ["events", sessionId],
    queryFn: () => api<EventListResponse>(`/sessions/${sessionId}/events?limit=500&order=asc`),
    enabled: !!sessionId,
    select: (d) => d.data,
  });
}
