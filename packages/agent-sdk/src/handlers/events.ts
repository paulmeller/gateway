import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
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
  return routeWrap(request, async () => {
    if (isProxied(sessionId)) {
      const remoteId = resolveRemoteSessionId(sessionId);
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

    return jsonOk({ events: appended.rows.map(rowToManagedEvent) });
  });
}

export function handleListEvents(request: Request, sessionId: string): Promise<Response> {
  return routeWrap(request, async () => {
    if (isProxied(sessionId)) {
      const remoteId = resolveRemoteSessionId(sessionId);
      return forwardToAnthropic(request, `/v1/sessions/${remoteId}/events`);
    }
    const session = getSession(sessionId);
    if (!session) throw notFound(`session ${sessionId} not found`);

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const order = (url.searchParams.get("order") === "desc" ? "desc" : "asc") as "asc" | "desc";
    const afterSeq = Number(url.searchParams.get("after_seq") ?? "0");

    const rows = listEvents(sessionId, { limit, order, afterSeq });
    return jsonOk({
      data: rows.map(rowToManagedEvent),
      next_page: rows.length > 0 ? String(rows[rows.length - 1].seq) : null,
    });
  });
}
