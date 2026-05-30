/**
 * Session thread handlers — multi-agent orchestration endpoints.
 *
 * Threads are delegated agent invocations within a coordinator session.
 * Each thread tracks its own agent, status, usage, and event stream.
 */
import { routeWrap, jsonOk, paginatedOk } from "../../http";
import { getDb } from "../../db/client";
import { getSession } from "../../db/sessions";
import { listEvents, rowToManagedEvent } from "../../db/events";
import {
  createThread,
  getThread,
  listThreads,
  archiveThread,
} from "../../db/threads";
import { getAgent } from "../../db/agents";
import { notFound, badRequest } from "../../errors";
import { assertResourceTenant, tenantFilter } from "../../auth/scope";
import { subscribe } from "../../sessions/bus";
import type { ManagedEvent } from "../../types";

/** Resolve session and assert tenant access. */
function loadSession(auth: import("../../types").AuthContext, sessionId: string) {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
    .get(sessionId) as { tenant_id: string | null } | undefined;
  if (!row) throw notFound(`session ${sessionId} not found`);
  assertResourceTenant(auth, row.tenant_id, `session ${sessionId} not found`);
  const session = getSession(sessionId);
  if (!session) throw notFound(`session ${sessionId} not found`);
  return session;
}

export function handleListThreads(request: Request, sessionId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadSession(auth, sessionId);

    const url = new URL(request.url);
    const limit = url.searchParams.get("limit");
    const order = url.searchParams.get("order") as "asc" | "desc" | null;

    const requestedLimit = limit ? Number(limit) : 50;
    const data = listThreads(sessionId, {
      limit: requestedLimit,
      order: order ?? undefined,
    });

    return paginatedOk(data, requestedLimit);
  });
}

export function handleGetThread(request: Request, sessionId: string, threadId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadSession(auth, sessionId);
    const thread = getThread(sessionId, threadId);
    if (!thread) throw notFound(`thread ${threadId} not found`);
    return jsonOk(thread);
  });
}

export function handleArchiveThread(request: Request, sessionId: string, threadId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadSession(auth, sessionId);
    const existing = getThread(sessionId, threadId);
    if (!existing) throw notFound(`thread ${threadId} not found`);
    if (existing.status !== "idle") {
      throw badRequest(`cannot archive thread in status "${existing.status}" — must be idle`);
    }
    const archived = archiveThread(sessionId, threadId);
    if (!archived) throw notFound(`thread ${threadId} not found`);
    return jsonOk(archived);
  });
}

export function handleListThreadEvents(request: Request, sessionId: string, threadId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadSession(auth, sessionId);
    const thread = getThread(sessionId, threadId);
    if (!thread) throw notFound(`thread ${threadId} not found`);

    const url = new URL(request.url);
    const limit = url.searchParams.get("limit");
    const order = url.searchParams.get("order") as "asc" | "desc" | null;
    const afterSeq = url.searchParams.get("after_seq");

    const requestedLimit = limit ? Number(limit) : 50;

    // Get all events for this session, then filter by thread_id
    // This works because thread events are stored in the parent session's
    // event log with thread_id set.
    const allEvents = listEvents(sessionId, {
      limit: 500, // fetch more than needed since we filter
      order: order ?? "asc",
      afterSeq: afterSeq ? Number(afterSeq) : undefined,
    });

    const threadEvents = allEvents
      .filter((e) => {
        const payload = JSON.parse(e.payload_json) as Record<string, unknown>;
        return payload.thread_id === threadId || e.type.startsWith("session.thread_");
      })
      .slice(0, requestedLimit)
      .map(rowToManagedEvent);

    return paginatedOk(threadEvents, requestedLimit);
  });
}

export function handleStreamThreadEvents(request: Request, sessionId: string, threadId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadSession(auth, sessionId);
    const thread = getThread(sessionId, threadId);
    if (!thread) throw notFound(`thread ${threadId} not found`);

    const url = new URL(request.url);
    const lastEventId = request.headers.get("last-event-id");
    const afterSeq = lastEventId
      ? Number(lastEventId)
      : Number(url.searchParams.get("after_seq") ?? "0");

    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });

    const write = (payload: string) => {
      try { controller.enqueue(encoder.encode(payload)); } catch { /* closed */ }
    };

    // Subscribe to parent session events, filter by thread_id
    const sub = subscribe(
      sessionId,
      Number.isFinite(afterSeq) ? afterSeq : 0,
      (evt: ManagedEvent) => {
        // Only forward events that belong to this thread
        if ((evt as Record<string, unknown>).thread_id === threadId) {
          write(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
        }
      },
    );

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
  });
}
