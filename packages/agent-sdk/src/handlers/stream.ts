import { ensureInitialized } from "../init";
import { authenticate } from "../auth/middleware";
import { subscribe, type Subscription } from "../sessions/bus";
import { getDb } from "../db/client";
import { getSession } from "../db/sessions";
import { isProxied, getProxiedTenantId } from "../db/proxy";
import { resolveRemoteSessionId } from "../db/sync";
import { forwardToAnthropic } from "../proxy/forward";
import { toResponse, notFound } from "../errors";
import { assertResourceTenant } from "../auth/scope";
import type { ManagedEvent } from "../types";

/**
 * Prepared stream result — either a Response (error/proxy) or the
 * subscribe function + afterSeq for the adapter to wire into its
 * streaming primitive (Hono streamSSE, Fastify reply.raw, etc.).
 */
export interface PreparedStream {
  afterSeq: number;
  subscribeFn: (
    fromSeq: number,
    onEvent: (evt: ManagedEvent) => void,
  ) => Subscription;
}

/**
 * Authenticate, tenant-check, and resolve the session for SSE streaming.
 * Returns either a Response (for errors or proxy forwarding) or a
 * PreparedStream that the adapter can wire into its own streaming API.
 */
export async function prepareSessionStream(
  request: Request,
  sessionId: string,
): Promise<Response | PreparedStream> {
  try {
    await ensureInitialized();
    const auth = await authenticate(request);

    // Tenant guard
    const tenantRow = getDb()
      .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { tenant_id: string | null } | undefined;
    if (tenantRow) {
      assertResourceTenant(auth, tenantRow.tenant_id, `session ${sessionId} not found`);
    } else {
      const proxyTenant = getProxiedTenantId(sessionId);
      if (proxyTenant !== undefined) {
        assertResourceTenant(auth, proxyTenant, `session ${sessionId} not found`);
      }
    }

    // Proxy — forward to Anthropic
    if (isProxied(sessionId)) {
      const localSession = getSession(sessionId);
      if (!localSession) {
        const remoteId = resolveRemoteSessionId(sessionId);
        const res = await forwardToAnthropic(request, `/v1/sessions/${remoteId}/events/stream`);
        const headers = new Headers(res.headers);
        headers.set("X-Accel-Buffering", "no");
        return new Response(res.body, { status: res.status, headers });
      }
    }

    const session = getSession(sessionId);
    if (!session) throw notFound(`session ${sessionId} not found`);

    const url = new URL(request.url);
    const lastEventId = request.headers.get("last-event-id");
    const afterSeq = lastEventId
      ? Number(lastEventId)
      : Number(url.searchParams.get("after_seq") ?? "0");

    return {
      afterSeq: Number.isFinite(afterSeq) ? afterSeq : 0,
      subscribeFn: (fromSeq, onEvent) => subscribe(sessionId, fromSeq, onEvent),
    };
  } catch (err) {
    return toResponse(err);
  }
}

/**
 * Legacy handler for adapters that don't have their own streaming primitive
 * (Fastify, Next.js, CLI LocalBackend). Uses ReadableStream directly.
 */
export async function handleSessionStream(request: Request, sessionId: string): Promise<Response> {
  const result = await prepareSessionStream(request, sessionId);
  if (result instanceof Response) return result;

  const { afterSeq, subscribeFn } = result;
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });

  const write = (payload: string) => {
    try { controller.enqueue(encoder.encode(payload)); } catch { /* closed */ }
  };

  const sub = subscribeFn(afterSeq, (evt) => {
    write(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  });

  const keepalive = setInterval(() => {
    write(`data: {"type":"ping"}\n\n`);
  }, 15_000);

  const abort = () => {
    clearInterval(keepalive);
    sub.unsubscribe();
    try { controller.close(); } catch { /* ignore */ }
  };
  request.signal.addEventListener("abort", abort);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
