import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "@/stores/app-store";
import type { SessionEvent } from "./use-events";

export function useSSE(sessionId: string | null) {
  const qc = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  const delayRef = useRef(1000);

  useEffect(() => {
    if (!sessionId) return;

    seqRef.current = 0;
    delayRef.current = 1000;

    function connect() {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const apiKey = useAppStore.getState().apiKey;
      const url = `/v1/sessions/${sessionId}/stream?after_seq=${seqRef.current}`;

      fetch(url, {
        signal: ctrl.signal,
        headers: { "x-api-key": apiKey },
      })
        .then(async (res) => {
          if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
          delayRef.current = 1000;

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              try {
                const event = JSON.parse(line.slice(5).trimStart()) as SessionEvent;
                seqRef.current = Math.max(seqRef.current, event.seq);

                qc.setQueryData<{ data: SessionEvent[] }>(
                  ["events", sessionId],
                  (old) => {
                    if (!old) return { data: [event] };
                    const exists = old.data.some((e) => e.seq === event.seq);
                    if (exists) return old;
                    return { data: [...old.data, event] };
                  },
                );

                if (event.type.startsWith("session.status")) {
                  qc.invalidateQueries({ queryKey: ["sessions", sessionId] });
                  qc.invalidateQueries({ queryKey: ["sessions"] });
                }
              } catch {
                // skip malformed lines
              }
            }
          }
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          console.warn("[sse] disconnected:", err);
        })
        .finally(() => {
          if (ctrl.signal.aborted) return;
          const delay = delayRef.current;
          delayRef.current = Math.min(delay * 2, 30_000);
          setTimeout(connect, delay);
        });
    }

    connect();
    return () => abortRef.current?.abort();
  }, [sessionId, qc]);
}
