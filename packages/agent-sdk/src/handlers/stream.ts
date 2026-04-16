import { ensureInitialized } from "../init";
import { authenticate } from "../auth/middleware";
import { subscribe } from "../sessions/bus";
import { getSession } from "../db/sessions";
import { isProxied } from "../db/proxy";
import { resolveRemoteSessionId } from "../db/sync";
import { forwardToAnthropic } from "../proxy/forward";
import { toResponse, notFound } from "../errors";
import type { ManagedEvent } from "../types";

export async function handleSessionStream(request: Request, sessionId: string): Promise<Response> {
  try {
    await ensureInitialized();
    await authenticate(request);

    if (isProxied(sessionId)) {
      const remoteId = resolveRemoteSessionId(sessionId);
      const res = await forwardToAnthropic(request, `/v1/sessions/${remoteId}/stream`);
      const headers = new Headers(res.headers);
      headers.set("X-Accel-Buffering", "no");
      return new Response(res.body, { status: res.status, headers });
    }

    const session = getSession(sessionId);
    if (!session) throw notFound(`session ${sessionId} not found`);

    const url = new URL(request.url);
    const lastEventId = request.headers.get("last-event-id");
    const afterSeq = lastEventId
      ? Number(lastEventId)
      : Number(url.searchParams.get("after_seq") ?? "0");

    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    const write = (payload: string) => {
      writer.write(encoder.encode(payload)).catch(() => {});
    };

    const writeEvent = (evt: ManagedEvent) => {
      const lines = [
        `id: ${evt.seq}`,
        `event: ${evt.type}`,
        `data: ${JSON.stringify(evt)}`,
        "",
        "",
      ].join("\n");
      write(lines);
    };

    const keepalive = setInterval(() => {
      write(`data: {"type":"ping"}\n\n`);
    }, 15_000);

    const sub = subscribe(sessionId, Number.isFinite(afterSeq) ? afterSeq : 0, writeEvent);

    const abort = () => {
      clearInterval(keepalive);
      sub.unsubscribe();
      try {
        writer.close();
      } catch { /* ignore */ }
    };
    request.signal.addEventListener("abort", abort);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return toResponse(err);
  }
}
