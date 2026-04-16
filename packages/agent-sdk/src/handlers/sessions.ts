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

/**
 * FallbackTuple declared on agents.fallback_json. On session-creation
 * failure for classifiable reasons (retryable error, 5xx from upstream,
 * env-not-ready), the handler walks this chain and tries each in order.
 * Max 3 hops; cycles are detected and short-circuit exhaustion.
 */
interface FallbackTuple {
  agent_id: string;
  environment_id: string;
}

/**
 * Errors thrown by session-creation that are candidates for triggering
 * the fallback chain. Non-retryable 4xx (scope, vault ownership,
 * engine-provider compat, billing, bad request) are propagated
 * unchanged — those masquerade config mistakes as transient issues.
 */
function shouldFallback(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Our own env-not-ready guard throws badRequest. We explicitly want to
  // try fallbacks for this — it's the canonical "primary is sick" case.
  if (/environment is not ready/i.test(msg)) return true;
  // Anthropic sync failures come through as Error("Anthropic API ...
  // failed (NNN): ...") — fall back on 5xx and 429.
  const upstreamMatch = /Anthropic API .* failed \((\d+)\)/i.exec(msg);
  if (upstreamMatch) {
    const code = Number(upstreamMatch[1]);
    if (code >= 500 || code === 429) return true;
    return false;
  }
  // Classify anything else via the existing retry taxonomy.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { classifyError } = require("../sessions/errors") as typeof import("../sessions/errors");
    return classifyError(msg).retryable;
  } catch {
    return false;
  }
}

function parseFallbackJson(raw: string | null | undefined): FallbackTuple[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: FallbackTuple[] = [];
    for (const item of parsed) {
      if (item && typeof item.agent_id === "string" && typeof item.environment_id === "string") {
        out.push({ agent_id: item.agent_id, environment_id: item.environment_id });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function handleCreateSession(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) : null;
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);
    // Capture the narrowed payload once so the inner tryCreate closure can
    // reach it without TS losing the narrowing across the async boundary.
    const data = parsed.data;

    const initialAgentId = typeof data.agent === "string" ? data.agent : data.agent.id;

    if (isProxied(initialAgentId)) {
      const proxyRes = await forwardToAnthropic(request, "/v1/sessions", { body: rawBody });
      if (proxyRes.ok) {
        try {
          const data = (await proxyRes.clone().json()) as { id: string };
          markProxied(data.id, "session");
        } catch { /* best-effort */ }
      }
      return proxyRes;
    }

    const initialAgentVersion =
      typeof data.agent === "string" ? undefined : data.agent.version;

    // Import helpers once up-front.
    const { checkResourceScope } = await import("../auth/scope");
    const { getVault } = await import("../db/vaults");

    /**
     * Attempt to create a session for (agentId, envId, agentVersion?).
     * Each failure throws; callers decide whether to retry the next
     * fallback based on `shouldFallback(err)`. Scope and vault-ownership
     * are validated per-attempt so fallback can't be a privilege
     * escalation.
     */
    async function tryCreate(
      agentId: string,
      envId: string,
      agentVersion: number | undefined,
    ): Promise<Response> {
      const agent = getAgent(agentId, agentVersion);
      if (!agent) throw notFound(`agent not found: ${agentId}`);

      const env = getEnvironment(envId);
      if (!env) throw notFound(`environment not found: ${envId}`);

      // Virtual-key scope per-attempt.
      checkResourceScope(auth, {
        agent: agent.id,
        env: env.id,
        vaults: data.vault_ids,
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
      if (data.vault_ids?.length) {
        for (const vid of data.vault_ids) {
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
        // Unified resolver: vault → pool → config cascade (v0.4 PR4).
        const { resolveAnthropicKey } = await import("../providers/upstream-keys");
        const resolved = resolveAnthropicKey({ vaultIds: data.vault_ids ?? undefined });
        if (!resolved) {
          throw badRequest(
            "ANTHROPIC_API_KEY required for anthropic provider " +
            "(add to vault, upstream-key pool, or .env)",
          );
        }

        const { remoteSessionId } = await syncAndCreateSession({
          agentId: agent.id,
          agentVersion: agent.version,
          environmentId: env.id,
          vaultIds: data.vault_ids ?? undefined,
          title: data.title ?? undefined,
          apiKey: resolved.value,
        });

        const session = createSession({
          agent_id: agent.id,
          agent_version: agent.version,
          environment_id: env.id,
          title: data.title ?? null,
          metadata: { ...data.metadata, _anthropic_session_id: remoteSessionId },
          max_budget_usd: data.max_budget_usd ?? null,
          resources: data.resources?.length ? data.resources : null,
          vault_ids: data.vault_ids?.length ? data.vault_ids : null,
          api_key_id: auth.keyId,
        });

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
        title: data.title ?? null,
        metadata: data.metadata ?? {},
        max_budget_usd: data.max_budget_usd ?? null,
        resources: data.resources?.length ? data.resources : null,
        vault_ids: data.vault_ids?.length ? data.vault_ids : null,
        api_key_id: auth.keyId,
      });

      getActor(session.id);
      return jsonOk(session, 201);
    }

    // Build the candidate chain: [primary, ...fallbacks-from-primary's-agent-row].
    // Cap at 3 hops total. Cycle-detect via visited (agent_id, env_id).
    const MAX_HOPS = 3;
    const primary: FallbackTuple = {
      agent_id: initialAgentId,
      environment_id: data.environment_id,
    };
    const primaryAgent = getAgent(initialAgentId, initialAgentVersion);
    const candidates: FallbackTuple[] = [primary];
    if (primaryAgent) {
      for (const fb of parseFallbackJson(primaryAgent.fallback_json ?? null)) {
        candidates.push(fb);
        if (candidates.length >= MAX_HOPS) break;
      }
    }

    const attempted: Array<FallbackTuple & { error: string }> = [];
    const visited = new Set<string>();
    let lastError: unknown = null;

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const visitKey = `${cand.agent_id}:${cand.environment_id}`;
      if (visited.has(visitKey)) continue; // cycle
      visited.add(visitKey);

      try {
        const res = await tryCreate(
          cand.agent_id,
          cand.environment_id,
          i === 0 ? initialAgentVersion : undefined,
        );
        // On fallback success, emit a telemetry event so the client sees
        // which step succeeded. Best-effort — don't let emit failure
        // derail the response.
        if (i > 0) {
          try {
            const sessionJson = await res.clone().json() as { id: string };
            const sessionId = sessionJson.id;
            appendEvent(sessionId, {
              type: "session.fallback_used",
              payload: { from: primary, to: cand, attempted },
              origin: "server",
              processedAt: nowMs(),
            });
          } catch { /* best-effort */ }
        }
        return res;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        attempted.push({ ...cand, error: msg });
        if (!shouldFallback(err)) {
          // Non-retryable (403, 400 scope/config, billing, etc.) —
          // propagate unchanged. No fallback for user-error.
          throw err;
        }
      }
    }

    // All candidates exhausted. Throw a wrapped error that surfaces the
    // full attempted chain, not just the last underlying failure — so an
    // operator can tell at a glance "fallback tried A → B, both failed".
    // lastError is preserved in the log surface; the response body gets
    // the structured message.
    const tail = attempted[attempted.length - 1]?.error ?? (lastError instanceof Error ? lastError.message : "unknown");
    const chain = attempted.map(a => `${a.agent_id}/${a.environment_id}`).join(" → ");
    const msg = `session creation failed after ${attempted.length} attempts. Attempted: ${chain}. Last error: ${tail}.`;
    throw badRequest(msg);
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
