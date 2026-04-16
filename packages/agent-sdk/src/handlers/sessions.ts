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
import { releaseSession } from "../containers/lifecycle";
import { isProxied, markProxied, unmarkProxied } from "../db/proxy";
import { forwardToAnthropic } from "../proxy/forward";
import { syncAndCreateSession } from "../sync/anthropic";
import { upsertSync, resolveRemoteSessionId } from "../db/sync";
import { getConfig } from "../config";
import { badRequest, notFound } from "../errors";
import { nowMs } from "../util/clock";
import type { SessionStatus } from "../types";

const ALLOWED_STATUSES: SessionStatus[] = ["idle", "running", "rescheduling", "terminated"];

const AgentRef = z.union([
  z.string(),
  z.object({ id: z.string(), version: z.number().int(), type: z.literal("agent").optional() }),
]);

const ResourceSchema = z.object({
  type: z.enum(["uri", "text", "file", "github_repository"]),
  uri: z.string().optional(),
  content: z.string().optional(),
  file_id: z.string().optional(),
  mount_path: z.string().optional(),
  repository_url: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
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
  return routeWrap(request, async ({ auth }) => {
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

    // Virtual-key scope: fail early if the caller's API key is not allowed
    // to use this agent, environment, or any requested vault. Happens after
    // resolution so we can return 403 for "scope denies" vs 404 for "resource
    // doesn't exist" — no id-probing via scope errors.
    const { checkResourceScope } = await import("../auth/scope");
    checkResourceScope(auth, {
      agent: agent.id,
      env: env.id,
      vaults: parsed.data.vault_ids,
    });

    // Engine-provider compatibility: anthropic provider only runs Claude models
    if (env.config?.provider === "anthropic" && agent.engine !== "claude") {
      throw badRequest(
        `${agent.engine} engine cannot run on the anthropic provider — ` +
        `Anthropic's managed agents API only supports Claude models. ` +
        `Use a container provider (docker, e2b, fly, etc.) instead.`,
      );
    }

    // Vault ownership: all vault_ids must belong to this agent
    if (parsed.data.vault_ids?.length) {
      const { getVault } = await import("../db/vaults");
      for (const vid of parsed.data.vault_ids) {
        const vault = getVault(vid);
        if (!vault) throw badRequest(`vault not found: ${vid}`);
        if (vault.agent_id !== agent.id) {
          throw badRequest(
            `vault ${vid} belongs to a different agent — vaults are scoped per-agent`,
          );
        }
      }
    }

    // ── Anthropic provider: sync local config → Anthropic, then proxy ──
    if (env.config?.provider === "anthropic") {
      // Prefer vault-provided key, fall back to server config
      let apiKey: string | undefined;
      if (parsed.data.vault_ids?.length) {
        const { listEntries } = await import("../db/vaults");
        for (const vid of parsed.data.vault_ids) {
          const entries = listEntries(vid);
          const found = entries.find(e => e.key === "ANTHROPIC_API_KEY");
          if (found) { apiKey = found.value; break; }
        }
      }
      if (!apiKey) {
        const cfg = getConfig();
        apiKey = cfg.anthropicApiKey;
      }
      if (!apiKey) throw badRequest("ANTHROPIC_API_KEY required for anthropic provider (add to vault or .env)");

      const { remoteSessionId } = await syncAndCreateSession({
        agentId,
        agentVersion: typeof parsed.data.agent === "string" ? undefined : parsed.data.agent.version,
        environmentId: parsed.data.environment_id,
        vaultIds: parsed.data.vault_ids ?? undefined,
        title: parsed.data.title ?? undefined,
        apiKey,
      });

      // Create local session record (for UI, event bus, analytics)
      const session = createSession({
        agent_id: agent.id,
        agent_version: agent.version,
        environment_id: env.id,
        title: parsed.data.title ?? null,
        metadata: { ...parsed.data.metadata, _anthropic_session_id: remoteSessionId },
        max_budget_usd: parsed.data.max_budget_usd ?? null,
        resources: parsed.data.resources?.length ? parsed.data.resources : null,
        vault_ids: parsed.data.vault_ids?.length ? parsed.data.vault_ids : null,
        api_key_id: auth.keyId,
      });

      // Map local session → remote session, mark as proxied
      upsertSync(session.id, "session", remoteSessionId);
      markProxied(session.id, "session");
      getActor(session.id);
      return jsonOk(session, 201);
    }

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
      api_key_id: auth.keyId,
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
    if (isProxied(id)) {
      // Sync-and-proxy sessions have a local record — return it
      const localSession = getSession(id);
      if (localSession) return jsonOk(localSession);
      // Pure proxy: forward to Anthropic
      return forwardToAnthropic(request, `/v1/sessions/${resolveRemoteSessionId(id)}`);
    }
    const session = getSession(id);
    if (!session) throw notFound(`session ${id} not found`);
    return jsonOk(session);
  });
}

export function handleUpdateSession(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    if (isProxied(id)) return forwardToAnthropic(request, `/v1/sessions/${resolveRemoteSessionId(id)}`);
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
      const res = await forwardToAnthropic(request, `/v1/sessions/${resolveRemoteSessionId(id)}`);
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
      const res = await forwardToAnthropic(request, `/v1/sessions/${resolveRemoteSessionId(id)}/archive`);
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
