import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import {
  createSession,
  getSession,
  listSessions,
  updateSessionMutable,
  updateSessionStatus,
  archiveSession,
} from "../db/sessions";
import { getAgent } from "../db/agents";
import { getEnvironment } from "../db/environments";
import { getActor, dropActor } from "../sessions/actor";
import { appendEvent, dropEmitter } from "../sessions/bus";
import { interruptSession } from "../sessions/interrupt";
import { releaseSession } from "../sprite/lifecycle";
import { isProxied, markProxied, unmarkProxied } from "../db/proxy";
import { forwardToAnthropic } from "../proxy/forward";
import { badRequest, notFound } from "../errors";
import { nowMs } from "../util/clock";
import type { SessionStatus } from "../types";

const ALLOWED_STATUSES: SessionStatus[] = ["idle", "running", "rescheduling", "terminated"];

const AgentRef = z.union([
  z.string(),
  z.object({ id: z.string(), version: z.number().int(), type: z.literal("agent").optional() }),
]);

const ResourceSchema = z.object({
  type: z.enum(["uri", "text"]),
  uri: z.string().optional(),
  content: z.string().optional(),
});

const CreateSchema = z.object({
  agent: AgentRef,
  environment_id: z.string(),
  title: z.string().nullish(),
  metadata: z.record(z.unknown()).optional(),
  max_budget_usd: z.number().positive().optional(),
  resources: z.array(ResourceSchema).optional(),
  vault_ids: z.array(z.string()).optional(),
});

const UpdateSchema = z.object({
  title: z.string().nullish(),
  metadata: z.record(z.unknown()).optional(),
  vault_ids: z.array(z.string()).optional(),
});

export function handleCreateSession(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) : null;
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const agentId = typeof parsed.data.agent === "string" ? parsed.data.agent : parsed.data.agent.id;

    if (isProxied(agentId)) {
      const proxyRes = await forwardToAnthropic(request, "/v1/sessions", { body: rawBody });
      if (proxyRes.ok) {
        try {
          const data = (await proxyRes.clone().json()) as { id: string };
          markProxied(data.id, "session");
        } catch { /* best-effort */ }
      }
      return proxyRes;
    }

    const agentVersion =
      typeof parsed.data.agent === "string" ? undefined : parsed.data.agent.version;

    const agent = getAgent(agentId, agentVersion);
    if (!agent) throw notFound(`agent not found: ${agentId}`);

    const env = getEnvironment(parsed.data.environment_id);
    if (!env) throw notFound(`environment not found: ${parsed.data.environment_id}`);
    if (env.state !== "ready") {
      throw badRequest(
        `environment is not ready (state=${env.state}${env.state_message ? `: ${env.state_message}` : ""})`,
      );
    }

    const session = createSession({
      agent_id: agent.id,
      agent_version: agent.version,
      environment_id: env.id,
      title: parsed.data.title ?? null,
      metadata: parsed.data.metadata ?? {},
      max_budget_usd: parsed.data.max_budget_usd ?? null,
      resources: parsed.data.resources?.length ? parsed.data.resources : null,
      vault_ids: parsed.data.vault_ids?.length ? parsed.data.vault_ids : null,
    });

    getActor(session.id);
    return jsonOk(session, 201);
  });
}

export function handleListSessions(request: Request): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit");
    const order = url.searchParams.get("order") as "asc" | "desc" | null;
    const includeArchived = url.searchParams.get("include_archived") === "true";
    const cursor = url.searchParams.get("page") ?? undefined;
    const agentId = url.searchParams.get("agent_id") ?? undefined;
    const agentVersion = url.searchParams.get("agent_version");
    const environmentId = url.searchParams.get("environment_id") ?? undefined;

    const statusRaw = url.searchParams.get("status");
    let status: SessionStatus | undefined;
    if (statusRaw != null) {
      if (!ALLOWED_STATUSES.includes(statusRaw as SessionStatus)) {
        throw badRequest(
          `invalid status value: ${statusRaw} (allowed: ${ALLOWED_STATUSES.join(",")})`,
        );
      }
      status = statusRaw as SessionStatus;
    }

    const data = listSessions({
      agent_id: agentId,
      agent_version: agentVersion ? Number(agentVersion) : undefined,
      environmentId,
      status,
      limit: limit ? Number(limit) : undefined,
      order: order ?? undefined,
      includeArchived,
      cursor,
      createdGt: parseMs(url.searchParams.get("created_at[gt]")),
      createdGte: parseMs(url.searchParams.get("created_at[gte]")),
      createdLt: parseMs(url.searchParams.get("created_at[lt]")),
      createdLte: parseMs(url.searchParams.get("created_at[lte]")),
    });
    return jsonOk({
      data,
      next_page: data.length > 0 ? data[data.length - 1].id : null,
    });
  });
}

export function handleGetSession(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    if (isProxied(id)) return forwardToAnthropic(request, `/v1/sessions/${id}`);
    const session = getSession(id);
    if (!session) throw notFound(`session ${id} not found`);
    return jsonOk(session);
  });
}

export function handleUpdateSession(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    if (isProxied(id)) return forwardToAnthropic(request, `/v1/sessions/${id}`);
    const body = await request.json().catch(() => null);
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const updated = updateSessionMutable(id, {
      title: parsed.data.title,
      metadata: parsed.data.metadata,
    });
    if (!updated) throw notFound(`session ${id} not found`);
    return jsonOk(updated);
  });
}

export function handleDeleteSession(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    if (isProxied(id)) {
      const res = await forwardToAnthropic(request, `/v1/sessions/${id}`);
      if (res.ok) unmarkProxied(id);
      return res;
    }
    const session = getSession(id);
    if (!session) throw notFound(`session ${id} not found`);

    const actor = getActor(id);
    await actor.enqueue(async () => {
      interruptSession(id);
      await releaseSession(id);
      appendEvent(id, {
        type: "session.status_terminated",
        payload: { reason: "deleted" },
        origin: "server",
        processedAt: nowMs(),
      });
      updateSessionStatus(id, "terminated", "deleted");
    });
    dropActor(id);
    dropEmitter(id);
    return jsonOk({ id, type: "session_deleted" });
  });
}

export function handleArchiveSession(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    if (isProxied(id)) {
      const res = await forwardToAnthropic(request, `/v1/sessions/${id}/archive`);
      if (res.ok) unmarkProxied(id);
      return res;
    }
    const session = getSession(id);
    if (!session) throw notFound(`session ${id} not found`);

    const actor = getActor(id);
    await actor.enqueue(async () => {
      await releaseSession(id);
      archiveSession(id);
    });
    return jsonOk(getSession(id));
  });
}

function parseMs(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}
