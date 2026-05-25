import { z } from "zod";
import { routeWrap, jsonOk, paginatedOk, decodeCursor } from "../http";
import { getEnvironment } from "../db/environments";
import {
  getWorkItem,
  listWorkItems,
  pollWorkItem,
  ackWorkItem,
  heartbeatWorkItem,
  stopWorkItem,
  updateWorkItemMetadata,
  getWorkQueueStats,
} from "../db/work";
import { badRequest, notFound } from "../errors";
import type { WorkState } from "../types";

function assertSelfHostedEnv(envId: string) {
  const env = getEnvironment(envId);
  if (!env) throw notFound(`environment not found: ${envId}`);
  if (env.config?.type !== "self_hosted")
    throw badRequest("work queue is only available on self_hosted environments");
  return env;
}

// ── List Work Items ─────────────────────────────────────────────────────

export function handleListWork(request: Request, envId: string): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
    assertSelfHostedEnv(envId);
    const url = new URL(req.url);
    const requestedLimit = Number(url.searchParams.get("limit") || "20");
    const cursor = decodeCursor(url.searchParams.get("after_id") ?? url.searchParams.get("page"));
    const state = (url.searchParams.get("state") as WorkState) ?? undefined;

    const items = listWorkItems(envId, { limit: requestedLimit, cursor, state });
    return paginatedOk(items, requestedLimit);
  });
}

// ── Get Work Item ───────────────────────────────────────────────────────

export function handleGetWork(request: Request, envId: string, workId: string): Promise<Response> {
  return routeWrap(request, async () => {
    assertSelfHostedEnv(envId);
    const item = getWorkItem(workId);
    if (!item || item.environment_id !== envId) throw notFound(`work item not found: ${workId}`);
    return jsonOk(item);
  });
}

// ── Update Work Item Metadata ───────────────────────────────────────────

const UpdateWorkSchema = z.object({
  metadata: z.record(z.union([z.string(), z.null()])),
});

export function handleUpdateWork(request: Request, envId: string, workId: string): Promise<Response> {
  return routeWrap(request, async () => {
    assertSelfHostedEnv(envId);

    const body = await request.json();
    const parsed = UpdateWorkSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const item = updateWorkItemMetadata(workId, parsed.data.metadata);
    if (!item || item.environment_id !== envId) throw notFound(`work item not found: ${workId}`);
    return jsonOk(item);
  });
}

// ── Poll Work ───────────────────────────────────────────────────────────

export function handlePollWork(request: Request, envId: string): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
    assertSelfHostedEnv(envId);
    const url = new URL(req.url);
    const workerId = url.searchParams.get("worker_id") ?? undefined;

    const item = pollWorkItem(envId, workerId);
    if (!item) return jsonOk({ data: null });
    return jsonOk(item);
  });
}

// ── Work Queue Stats ────────────────────────────────────────────────────

export function handleWorkStats(request: Request, envId: string): Promise<Response> {
  return routeWrap(request, async () => {
    assertSelfHostedEnv(envId);
    const stats = getWorkQueueStats(envId);
    return jsonOk(stats);
  });
}

// ── Acknowledge Work ────────────────────────────────────────────────────

const AckWorkSchema = z.object({
  worker_id: z.string().optional(),
}).optional();

export function handleAckWork(request: Request, envId: string, workId: string): Promise<Response> {
  return routeWrap(request, async () => {
    assertSelfHostedEnv(envId);

    let workerId: string | undefined;
    try {
      const body = await request.json();
      const parsed = AckWorkSchema.safeParse(body);
      if (parsed.success && parsed.data) {
        workerId = parsed.data.worker_id;
      }
    } catch {
      // empty body is fine
    }

    const item = ackWorkItem(workId, workerId);
    if (!item) throw notFound(`work item not found or not in pending state: ${workId}`);
    if (item.environment_id !== envId) throw notFound(`work item not found: ${workId}`);
    return jsonOk(item);
  });
}

// ── Heartbeat Work ──────────────────────────────────────────────────────

export function handleHeartbeatWork(request: Request, envId: string, workId: string): Promise<Response> {
  return routeWrap(request, async () => {
    assertSelfHostedEnv(envId);

    // Verify the item belongs to this environment
    const existing = getWorkItem(workId);
    if (!existing || existing.environment_id !== envId)
      throw notFound(`work item not found: ${workId}`);

    const result = heartbeatWorkItem(workId);
    if (!result) throw notFound(`work item not found: ${workId}`);
    return jsonOk(result);
  });
}

// ── Stop Work ───────────────────────────────────────────────────────────

const StopWorkSchema = z.object({
  force: z.boolean().optional(),
}).optional();

export function handleStopWork(request: Request, envId: string, workId: string): Promise<Response> {
  return routeWrap(request, async () => {
    assertSelfHostedEnv(envId);

    let force: boolean | undefined;
    try {
      const body = await request.json();
      const parsed = StopWorkSchema.safeParse(body);
      if (parsed.success && parsed.data) {
        force = parsed.data.force;
      }
    } catch {
      // empty body is fine
    }

    const item = stopWorkItem(workId, force);
    if (!item || item.environment_id !== envId) throw notFound(`work item not found: ${workId}`);
    return jsonOk(item);
  });
}
