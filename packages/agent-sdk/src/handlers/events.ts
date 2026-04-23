import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { getDb } from "../db/client";
import { getSession, getSessionRow, setOutcomeCriteria } from "../db/sessions";
import { listEvents, rowToManagedEvent } from "../db/events";
import { appendEvent } from "../sessions/bus";
import { getActor } from "../sessions/actor";
import { interruptSession } from "../sessions/interrupt";
import { runTurn, writePermissionResponse } from "../sessions/driver";
import { enqueueTurn } from "../queue";
import { pushPendingUserInput, type TurnInput } from "../state";
import { isProxied } from "../db/proxy";
import { resolveRemoteSessionId } from "../db/sync";
import { forwardToAnthropic } from "../proxy/forward";
import { badRequest, notFound } from "../errors";
import { getAgent } from "../db/agents";
import { resolveAnthropicKey as resolveAnthropicKeyShared, reportUpstreamFailure, reportUpstreamSuccess } from "../providers/upstream-keys";
import { assertResourceTenant } from "../auth/scope";
import { getProxiedTenantId } from "../db/proxy";
import {
  listMemories,
  searchMemories,
  createOrUpsertMemory,
  updateMemory,
  getMemory,
  deleteMemory as deleteMemoryRow,
  listMemoryStores,
} from "../db/memory";
import type { AuthContext } from "../types";

/**
 * Tenant guard for session-scoped endpoints (events, resources).
 * Checks the local `sessions` row first; falls through to
 * `proxy_resources` for pure-proxy sessions (Anthropic engine, no
 * local mirror). This two-source check must stay in sync with the
 * pattern in stream.ts and sessions.ts.
 */
function assertSessionTenant(auth: AuthContext, sessionId: string): void {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
    .get(sessionId) as { tenant_id: string | null } | undefined;
  if (row) {
    assertResourceTenant(auth, row.tenant_id, `session ${sessionId} not found`);
    return;
  }
  // No local row — check proxy_resources for pure-proxy sessions.
  const proxyTenant = getProxiedTenantId(sessionId);
  if (proxyTenant !== undefined) {
    assertResourceTenant(auth, proxyTenant, `session ${sessionId} not found`);
    return;
  }
  // Neither table has this id — let the downstream handler 404.
  throw notFound(`session ${sessionId} not found`);
}

/**
 * Background-stream the remote Anthropic session and tee events into the
 * local event bus. This powers the local SSE stream for the UI.
 *
 * Logging is gated behind DEBUG_SYNC=1. Without the flag the tee is
 * silent on success paths — a busy gateway would otherwise emit one
 * [tee] line per SSE event.
 */
const teeLog = (...args: unknown[]): void => {
  if (process.env.DEBUG_SYNC === "1") console.log(...args);
};

/** Prevent overlapping tee instances for the same local session. */
const activeTees = new Set<string>();
/** Exported for testing only. */
export { activeTees as _activeTees };

/** Max re-entry iterations per teeRemoteStream invocation. */
const MAX_TEE_REENTRIES = 25;

/**
 * Execute a server-side custom tool and return the result text.
 * Returns null for unknown tools (left for the client to handle).
 *
 * Currently supports:
 *   - `memory` (with commands: view, search, create, update)
 */
export async function executeServerSideTool(
  toolName: string,
  input: Record<string, unknown>,
  sessionId: string,
): Promise<{ content: string } | null> {
  if (toolName === "memory" || toolName.startsWith("memory_")) {
    return executeMemoryTool(input, sessionId);
  }
  // Unknown tool — leave for client
  return null;
}

function executeMemoryTool(
  input: Record<string, unknown>,
  _sessionId: string,
): { content: string } | null {
  const command = String(input.command ?? "");
  const storeId = String(input.store_id ?? "");

  if (command === "view") {
    if (!storeId) return { content: JSON.stringify({ error: "store_id is required" }) };
    const memories = listMemories(storeId);
    return { content: JSON.stringify({ memories }) };
  }

  if (command === "search") {
    if (!storeId) return { content: JSON.stringify({ error: "store_id is required" }) };
    const query = String(input.query ?? "");
    if (!query) return { content: JSON.stringify({ error: "query is required" }) };
    const memories = searchMemories(storeId, query);
    return { content: JSON.stringify({ memories }) };
  }

  if (command === "create") {
    if (!storeId) return { content: JSON.stringify({ error: "store_id is required" }) };
    const content = String(input.content ?? "");
    if (!content) return { content: JSON.stringify({ error: "content is required" }) };
    const path = String(input.path ?? `auto_${Date.now()}`);
    const memory = createOrUpsertMemory(storeId, path, content);
    return { content: JSON.stringify({ memory }) };
  }

  if (command === "update") {
    const memoryId = String(input.memory_id ?? "");
    if (!memoryId) return { content: JSON.stringify({ error: "memory_id is required" }) };
    const content = String(input.content ?? "");
    if (!content) return { content: JSON.stringify({ error: "content is required" }) };
    const { memory, conflict } = updateMemory(memoryId, content);
    if (conflict) return { content: JSON.stringify({ error: "conflict", detail: "content changed since last read" }) };
    if (!memory) return { content: JSON.stringify({ error: "not_found" }) };
    return { content: JSON.stringify({ memory }) };
  }

  if (command === "delete") {
    const memoryId = String(input.memory_id ?? "");
    if (!memoryId) return { content: JSON.stringify({ error: "memory_id is required" }) };
    const existing = getMemory(memoryId);
    if (!existing) return { content: JSON.stringify({ error: "not_found" }) };
    deleteMemoryRow(memoryId);
    return { content: JSON.stringify({ deleted: true }) };
  }

  if (command === "list_stores") {
    const stores = listMemoryStores();
    return { content: JSON.stringify({ stores }) };
  }

  return { content: JSON.stringify({ error: `unknown memory command: ${command}` }) };
}

async function teeRemoteStream(localSessionId: string, remoteSessionId: string): Promise<void> {
  if (activeTees.has(localSessionId)) return;
  activeTees.add(localSessionId);

  try {
    await teeRemoteStreamInner(localSessionId, remoteSessionId);
  } finally {
    activeTees.delete(localSessionId);
  }
}

async function teeRemoteStreamInner(localSessionId: string, remoteSessionId: string): Promise<void> {
  const resolved = resolveAnthropicKeyShared({ sessionId: localSessionId });
  if (!resolved) { teeLog("[tee] no API key"); return; }
  const { value: apiKey, poolId } = resolved;

  const seenIds = new Set<string>();
  let reentryCount = 0;

  // Outer loop: re-opens the SSE stream after handling a server-side tool
  while (reentryCount <= MAX_TEE_REENTRIES) {
    teeLog(`[tee] connecting to Anthropic stream for ${remoteSessionId} (iteration ${reentryCount})`);
    const res = await fetch(`https://api.anthropic.com/v1/sessions/${remoteSessionId}/stream`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "agent-api-2026-03-01",
        "accept": "text/event-stream",
      },
    });
    if (!res.ok || !res.body) {
      teeLog(`[tee] stream failed: ${res.status}`);
      if (res.status >= 500 || res.status === 429 || res.status === 401) {
        reportUpstreamFailure(poolId);
      }
      return;
    }
    if (reentryCount === 0) reportUpstreamSuccess(poolId);
    teeLog(`[tee] stream connected`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawRequiresAction = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let eventData = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            eventData += line.slice(6);
          } else if (line === "" && eventData) {
            try {
              const evt = JSON.parse(eventData);
              const evtId = evt.id ?? "";
              if (evtId && seenIds.has(evtId)) { eventData = ""; continue; }
              if (evtId) seenIds.add(evtId);
              // Skip user events — already stored by the POST handler
              if (evt.type === "user" || evt.type === "user.message" || evt.type === "user.custom_tool_result") {
                eventData = "";
                continue;
              }
              const typeMap: Record<string, string> = {
                "agent": "agent.message",
                "status_running": "session.status_running",
                "status_idle": "session.status_idle",
                "model_request_start": "span.model_request_start",
                "model_request_end": "span.model_request_end",
              };
              const localType = typeMap[evt.type] ?? evt.type;
              teeLog(`[tee] event: ${localType}`);
              appendEvent(localSessionId, {
                type: localType,
                payload: evt,
                origin: "server",
                processedAt: Date.now(),
              });

              // Detect requires_action stop reason
              if (localType === "session.status_idle") {
                const stopReason = evt.stop_reason;
                if (
                  stopReason?.type === "requires_action" ||
                  stopReason === "requires_action"
                ) {
                  sawRequiresAction = true;
                }
              }
            } catch { /* skip unparseable */ }
            eventData = "";
          }
        }
      }
    } catch (err) { teeLog(`[tee] stream ended:`, err); }

    // If the session stopped with requires_action, try to handle the tool server-side
    if (!sawRequiresAction) return;

    teeLog(`[tee] detected requires_action — checking for server-side tool`);

    // Find the most recent agent.custom_tool_use event
    const recentEvents = listEvents(localSessionId, { limit: 20, order: "desc" });
    const toolEvt = recentEvents.find((e) => e.type === "agent.custom_tool_use");
    if (!toolEvt) {
      teeLog(`[tee] no agent.custom_tool_use found`);
      return;
    }

    let payload: { name?: string; tool_use_id?: string; input?: Record<string, unknown> };
    try {
      payload = JSON.parse(toolEvt.payload_json) as typeof payload;
    } catch {
      teeLog(`[tee] failed to parse tool event payload`);
      return;
    }

    const toolName = payload.name ?? "";
    const toolUseId = payload.tool_use_id ?? toolEvt.id;
    const toolInput = payload.input ?? {};

    const result = await executeServerSideTool(toolName, toolInput, localSessionId);
    if (!result) {
      teeLog(`[tee] tool "${toolName}" not handled server-side — leaving as requires_action`);
      return;
    }

    teeLog(`[tee] tool "${toolName}" handled server-side — sending result to Anthropic`);

    // Append the tool result to the local event bus
    appendEvent(localSessionId, {
      type: "user.custom_tool_result",
      payload: {
        custom_tool_use_id: toolUseId,
        content: [{ type: "text", text: result.content }],
      },
      origin: "server",
      processedAt: Date.now(),
    });

    // Send the tool result to Anthropic directly (NOT via handlePostEvents)
    const postRes = await fetch(
      `https://api.anthropic.com/v1/sessions/${remoteSessionId}/events`,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "agent-api-2026-03-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          events: [{
            type: "user.custom_tool_result",
            custom_tool_use_id: toolUseId,
            content: [{ type: "text", text: result.content }],
          }],
        }),
      },
    );

    if (!postRes.ok) {
      teeLog(`[tee] failed to send tool result to Anthropic: ${postRes.status}`);
      return;
    }

    teeLog(`[tee] tool result sent — re-opening stream`);
    reentryCount++;
  }

  if (reentryCount > MAX_TEE_REENTRIES) {
    console.warn(`[tee] max re-entry depth (${MAX_TEE_REENTRIES}) exceeded for session ${localSessionId}`);
  }
}
import { nowMs } from "../util/clock";
import type { EventRow } from "../types";

const TextBlock = z.object({ type: z.literal("text"), text: z.string() });

const UserMessage = z.object({
  type: z.literal("user.message"),
  content: z.array(TextBlock).min(1),
});

const UserInterrupt = z.object({ type: z.literal("user.interrupt") });

const UserToolConfirmation = z.object({
  type: z.literal("user.tool_confirmation"),
  tool_use_id: z.string().optional(),
  result: z.enum(["allow", "deny"]).optional(),
  deny_message: z.string().optional(),
});

const UserCustomToolResult = z.object({
  type: z.literal("user.custom_tool_result"),
  custom_tool_use_id: z.string(),
  content: z.array(z.unknown()),
});

const UserDefineOutcome = z.object({
  type: z.literal("user.define_outcome"),
  description: z.string().min(1),
  rubric: z.string().optional(),
  max_iterations: z.number().int().min(1).max(20).optional(),
});

const UserEvent = z.union([
  UserMessage,
  UserInterrupt,
  UserToolConfirmation,
  UserCustomToolResult,
  UserDefineOutcome,
]);

const BatchSchema = z.object({
  events: z.array(UserEvent).min(1),
});

export function handlePostEvents(request: Request, sessionId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    assertSessionTenant(auth, sessionId);
    if (isProxied(sessionId)) {
      const remoteId = resolveRemoteSessionId(sessionId);
      const localSession = getSession(sessionId);

      // For sync-and-proxy sessions (local record exists), tee events into local bus
      if (localSession) {
        const rawBody = await request.text();
        try {
          const body = JSON.parse(rawBody);
          if (body?.events) {
            for (const evt of body.events) {
              appendEvent(sessionId, {
                type: evt.type === "user.message" ? "user.message" : evt.type,
                payload: evt,
                origin: "user",
                processedAt: Date.now(),
              });
            }
          }
        } catch { /* best-effort */ }

        // Forward to Anthropic (use vault / pool / config key), then tee the response into local bus
        const resolvedKey = resolveAnthropicKeyShared({ sessionId });
        const proxyRes = await forwardToAnthropic(
          request,
          `/v1/sessions/${remoteId}/events`,
          { body: rawBody, apiKey: resolvedKey?.value },
        );
        // Pool-source failure tracking for the forward leg.
        if (!proxyRes.ok && (proxyRes.status >= 500 || proxyRes.status === 429 || proxyRes.status === 401)) {
          reportUpstreamFailure(resolvedKey?.poolId ?? null);
        } else if (proxyRes.ok) {
          reportUpstreamSuccess(resolvedKey?.poolId ?? null);
        }

        // Background: stream remote session to capture agent responses
        teeRemoteStream(sessionId, remoteId).catch(() => {});

        return proxyRes;
      }

      return forwardToAnthropic(request, `/v1/sessions/${remoteId}/events`);
    }
    const session = getSession(sessionId);
    if (!session) throw notFound(`session ${sessionId} not found`);

    const body = await request.json().catch(() => null);
    const parsed = BatchSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    for (const event of parsed.data.events) {
      if (event.type === "user.tool_confirmation") {
        const agent = getAgent(session.agent.id, session.agent.version);
        if (!agent?.confirmation_mode) {
          throw badRequest(
            "user.tool_confirmation is not supported: this agent does not have confirmation_mode enabled. " +
            "Set confirmation_mode: true on the agent to use tool confirmation.",
          );
        }
      }
    }

    const idemHeader = request.headers.get("idempotency-key") || request.headers.get("Idempotency-Key");
    const actor = getActor(sessionId);

    const hasInterrupt = parsed.data.events.some((e) => e.type === "user.interrupt");
    if (hasInterrupt) {
      interruptSession(sessionId);
    }

    const appended: { rows: EventRow[]; pendingForTurn: TurnInput[] } = await actor.enqueue(async () => {
      const rows: EventRow[] = [];
      const pendingForTurn: TurnInput[] = [];
      let sawInterrupt = false;

      for (const [idx, event] of parsed.data.events.entries()) {
        const ik = idemHeader ? `${idemHeader}:${idx}` : null;

        if (event.type === "user.interrupt") {
          const row = appendEvent(sessionId, {
            type: "user.interrupt",
            payload: {},
            origin: "user",
            idempotencyKey: ik,
            processedAt: nowMs(),
          });
          rows.push(row);
          sawInterrupt = true;
          continue;
        }

        if (event.type === "user.message") {
          const text = event.content.map((b) => b.text).join("");
          const row = appendEvent(sessionId, {
            type: "user.message",
            payload: { content: event.content },
            origin: "user",
            idempotencyKey: ik,
            processedAt: null,
          });
          rows.push(row);

          const inp: TurnInput = { kind: "text", eventId: row.id, text };
          const currentStatus = getSessionRow(sessionId)?.status ?? "idle";
          if (currentStatus === "running" || sawInterrupt) {
            pushPendingUserInput({ sessionId, input: inp });
          } else {
            pendingForTurn.push(inp);
          }
          continue;
        }

        if (event.type === "user.custom_tool_result") {
          const row = appendEvent(sessionId, {
            type: "user.custom_tool_result",
            payload: {
              custom_tool_use_id: event.custom_tool_use_id,
              content: event.content,
            },
            origin: "user",
            idempotencyKey: ik,
            processedAt: nowMs(),
          });
          rows.push(row);

          const inp: TurnInput = {
            kind: "tool_result",
            eventId: row.id,
            custom_tool_use_id: event.custom_tool_use_id,
            content: event.content as unknown[],
          };
          const currentStatus = getSessionRow(sessionId)?.status ?? "idle";
          if (currentStatus === "running" || sawInterrupt) {
            pushPendingUserInput({ sessionId, input: inp });
          } else {
            pendingForTurn.push(inp);
          }
          continue;
        }

        if (event.type === "user.tool_confirmation") {
          const confirmResult = event.result ?? "allow";
          const row = appendEvent(sessionId, {
            type: "user.tool_confirmation",
            payload: {
              tool_use_id: event.tool_use_id ?? null,
              result: confirmResult,
              deny_message: event.deny_message ?? null,
            },
            origin: "user",
            idempotencyKey: ik,
            processedAt: nowMs(),
          });
          rows.push(row);

          void writePermissionResponse(
            sessionId,
            confirmResult,
            event.deny_message ?? undefined,
          ).catch((err: unknown) => {
            console.warn(`[events] writePermissionResponse failed:`, err);
          });
          continue;
        }

        if (event.type === "user.define_outcome") {
          const { type: _type, ...criteria } = event;
          const row = appendEvent(sessionId, {
            type: "user.define_outcome",
            payload: criteria,
            origin: "user",
            idempotencyKey: ik,
            processedAt: nowMs(),
          });
          rows.push(row);
          setOutcomeCriteria(sessionId, criteria);
          continue;
        }
      }

      return { rows, pendingForTurn };
    });

    if (appended.pendingForTurn.length > 0) {
      const row = getSessionRow(sessionId);
      if (row) {
        void enqueueTurn(row.environment_id, () => runTurn(sessionId, appended.pendingForTurn)).catch(
          (err: unknown) => {
            console.error(`[events] enqueueTurn failed:`, err);
          },
        );
      }
    }

    return jsonOk({ data: appended.rows.map(rowToManagedEvent) });
  });
}

export function handleListEvents(request: Request, sessionId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    assertSessionTenant(auth, sessionId);
    if (isProxied(sessionId)) {
      // Sync-and-proxy sessions have local events — serve from local DB
      const localSession = getSession(sessionId);
      if (!localSession) {
        const remoteId = resolveRemoteSessionId(sessionId);
        return forwardToAnthropic(request, `/v1/sessions/${remoteId}/events`);
      }
      // Fall through to local handler
    }
    const session = getSession(sessionId);
    if (!session) throw notFound(`session ${sessionId} not found`);

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const order = (url.searchParams.get("order") === "desc" ? "desc" : "asc") as "asc" | "desc";
    const afterSeq = Number(url.searchParams.get("after_seq") ?? url.searchParams.get("page") ?? "0");

    const rows = listEvents(sessionId, { limit, order, afterSeq });
    return jsonOk({
      data: rows.map(rowToManagedEvent),
      next_page: rows.length > 0 ? String(rows[rows.length - 1].seq) : null,
    });
  });
}
