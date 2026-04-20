import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { getDb } from "../db/client";
import { createAgent, getAgent, updateAgent, archiveAgent, listAgents } from "../db/agents";
import { resolveBackend } from "../backends/registry";
import { isProxied, markProxied, unmarkProxied, getProxiedTenantId } from "../db/proxy";
import { forwardToAnthropic, validateAnthropicProxy } from "../proxy/forward";
import { badRequest, notFound, conflict } from "../errors";
import { assertResourceTenant, resolveCreateTenant, tenantFilter } from "../auth/scope";
import type { AuthContext } from "../types";

/**
 * Load the tenant_id column for an agent row directly. The public
 * `Agent` hydrate doesn't expose it (intentionally — the API doesn't
 * surface tenancy in resource bodies). Used for tenant assertions.
 */
function getAgentTenantId(id: string): string | null | undefined {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM agents WHERE id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

/** Common resolve-or-404 guard with tenant scoping. */
function loadAgentForCaller(auth: AuthContext, id: string, version?: number) {
  const tenantId = getAgentTenantId(id);
  if (tenantId === undefined) throw notFound(`agent ${id} not found`);
  assertResourceTenant(auth, tenantId, `agent ${id} not found`);
  const agent = getAgent(id, version);
  if (!agent) throw notFound(`agent ${id} not found`);
  return agent;
}

/**
 * Tenant guard for proxied agents. Proxied agents live in
 * `proxy_resources` and have no row in the local `agents` table, so
 * the regular loadAgentForCaller can't help. Legacy rows (no
 * tenant_id) resolve as global-admin-only.
 */
function assertProxiedAgentTenant(auth: AuthContext, id: string): void {
  const proxied = getProxiedTenantId(id);
  if (proxied === undefined) return; // not proxied after all
  assertResourceTenant(auth, proxied, `agent ${id} not found`);
}

const SkillSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  content: z.string().min(1).max(256 * 1024), // 256KB per skill
  installed_at: z.string().optional(),
});

const ToolSchema = z.union([
  z.object({
    type: z.literal("agent_toolset_20260401"),
    configs: z
      .array(z.object({ name: z.string(), enabled: z.boolean().optional() }))
      .optional(),
    default_config: z.object({ enabled: z.boolean().optional() }).optional(),
  }),
  z.object({
    type: z.literal("custom"),
    name: z.string().min(1),
    description: z.string(),
    input_schema: z.record(z.unknown()),
  }),
]);

const McpServerSchema = z.record(
  z.object({
    type: z.enum(["stdio", "http", "sse"]).optional(),
    url: z.string().optional(),
    command: z.union([z.string(), z.array(z.string())]).optional(),
    args: z.array(z.string()).optional(),
    headers: z.record(z.string()).optional(),
    env: z.record(z.string()).optional(),
  }),
);

const ModelConfigSchema = z.object({
  speed: z.enum(["standard", "fast"]).optional(),
});

const CreateSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  system: z.string().nullish(),
  tools: z.array(ToolSchema).optional(),
  mcp_servers: McpServerSchema.optional(),
  engine: z.enum(["claude", "opencode", "codex", "anthropic", "gemini", "factory", "pi"]).optional(),
  webhook_url: z.string().url().optional(),
  webhook_events: z.array(z.string()).optional(),
  /**
   * v0.5: shared secret for HMAC signing of webhook deliveries. Min
   * length 32 to nudge toward strong entropy; values shorter than that
   * are almost always a typo or misplaced username.
   */
  webhook_secret: z.string().min(32).max(512).optional(),
  threads_enabled: z.boolean().optional(),
  confirmation_mode: z.boolean().optional(),
  callable_agents: z.array(z.object({
    type: z.literal("agent"),
    id: z.string(),
    version: z.number().int().optional(),
  })).optional(),
  skills: z.array(SkillSchema).max(20).optional(),
  model_config: ModelConfigSchema.optional(),
  /** v0.5: required for global admin, ignored for tenant users. */
  tenant_id: z.string().optional(),
}).refine(data => {
  if (!data.skills) return true;
  const total = data.skills.reduce((sum, s) => sum + s.content.length, 0);
  return total <= 1024 * 1024; // 1MB total
}, "Total skills content exceeds 1MB limit");

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  system: z.string().nullish(),
  tools: z.array(z.unknown()).optional(),
  mcp_servers: z.record(z.unknown()).optional(),
  webhook_url: z.string().url().nullish(),
  webhook_events: z.array(z.string()).optional(),
  /** Null clears the secret (unsigned webhooks); string rotates it. */
  webhook_secret: z.string().min(32).max(512).nullish(),
  confirmation_mode: z.boolean().optional(),
  callable_agents: z.array(z.object({
    type: z.literal("agent"),
    id: z.string(),
    version: z.number().int().optional(),
  })).optional(),
  skills: z.array(SkillSchema).max(20).optional(),
  model_config: ModelConfigSchema.optional(),
}).refine(data => {
  if (!data.skills) return true;
  const total = data.skills.reduce((sum, s) => sum + s.content.length, 0);
  return total <= 1024 * 1024; // 1MB total
}, "Total skills content exceeds 1MB limit");

export function handleCreateAgent(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) : null;
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(`invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }

    const createTenantId = resolveCreateTenant(auth, parsed.data.tenant_id);

    // Check for duplicate name within the caller's tenant scope.
    const existing = listAgents({ limit: 1000, tenantFilter: tenantFilter(auth) });
    if (existing.some(a => a.name === parsed.data.name)) {
      throw conflict(`Agent with name "${parsed.data.name}" already exists`);
    }

    const backendName = parsed.data.engine ?? "claude";

    if (backendName === "anthropic") {
      const proxyErr = validateAnthropicProxy();
      if (proxyErr) throw badRequest(proxyErr);
      const proxyRes = await forwardToAnthropic(request, "/v1/agents", { body: rawBody });
      if (proxyRes.ok) {
        try {
          const data = (await proxyRes.clone().json()) as { id: string };
          // Stamp the caller's tenant so subsequent cross-tenant access
          // attempts against this proxy-only resource are rejected.
          markProxied(data.id, "agent", createTenantId);
        } catch { /* best-effort */ }
      }
      return proxyRes;
    }

    const backend = resolveBackend(backendName);

    // Validate model is supported by this engine
    const { isValidModelForEngine, MODELS } = await import("../backends/models");
    if (!isValidModelForEngine(backendName, parsed.data.model)) {
      throw badRequest(
        `Model "${parsed.data.model}" is not supported by the ${backendName} engine. ` +
        `Supported models: ${(MODELS[backendName] ?? []).join(", ")}`,
      );
    }

    if (backendName !== "claude" && parsed.data.tools && parsed.data.tools.length > 0) {
      throw badRequest(
        `${backendName} backend does not use agent tool configs; tools are managed by the backend's internal permission system. Omit the tools field for ${backendName} agents.`,
      );
    }

    const createErr = backend.validateAgentCreation?.();
    if (createErr) throw badRequest(createErr);

    const nowIso = new Date().toISOString();
    const agent = createAgent({
      name: parsed.data.name,
      model: parsed.data.model,
      system: parsed.data.system ?? null,
      tools: parsed.data.tools ?? [],
      mcp_servers: parsed.data.mcp_servers ?? {},
      backend: backendName,
      webhook_url: parsed.data.webhook_url ?? null,
      webhook_events: parsed.data.webhook_events,
      webhook_secret: parsed.data.webhook_secret ?? null,
      threads_enabled: parsed.data.threads_enabled ?? false,
      confirmation_mode: parsed.data.confirmation_mode ?? false,
      callable_agents: parsed.data.callable_agents,
      skills: parsed.data.skills?.map(s => ({
        ...s,
        installed_at: s.installed_at ?? nowIso,
      })),
      model_config: parsed.data.model_config,
      tenant_id: createTenantId,
    });
    return jsonOk(agent, 201);
  });
}

export function handleListAgents(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit");
    const order = url.searchParams.get("order") as "asc" | "desc" | null;
    const includeArchived = url.searchParams.get("include_archived") === "true";
    const cursor = url.searchParams.get("page") ?? undefined;

    const data = listAgents({
      limit: limit ? Number(limit) : undefined,
      order: order ?? undefined,
      includeArchived,
      cursor,
      tenantFilter: tenantFilter(auth),
    });
    return jsonOk({
      data,
      next_page: data.length > 0 ? data[data.length - 1].id : null,
    });
  });
}

export function handleGetAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedAgentTenant(auth, id);
      return forwardToAnthropic(request, `/v1/agents/${id}`);
    }
    const url = new URL(request.url);
    const versionParam = url.searchParams.get("version");
    const version = versionParam ? Number(versionParam) : undefined;
    const agent = loadAgentForCaller(auth, id, version);
    return jsonOk(agent);
  });
}

export function handleUpdateAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedAgentTenant(auth, id);
      return forwardToAnthropic(request, `/v1/agents/${id}`);
    }
    loadAgentForCaller(auth, id); // tenant guard
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

    if (body && typeof body === "object" && "backend" in body) {
      throw badRequest("backend cannot be changed after agent creation");
    }

    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const nowIso = new Date().toISOString();
    const updated = updateAgent(id, {
      name: parsed.data.name,
      model: parsed.data.model,
      system: parsed.data.system,
      tools: parsed.data.tools as never,
      mcp_servers: parsed.data.mcp_servers as never,
      webhook_url: parsed.data.webhook_url,
      webhook_events: parsed.data.webhook_events,
      webhook_secret: parsed.data.webhook_secret,
      confirmation_mode: parsed.data.confirmation_mode,
      callable_agents: parsed.data.callable_agents,
      skills: parsed.data.skills?.map(s => ({
        ...s,
        installed_at: s.installed_at ?? nowIso,
      })),
      model_config: parsed.data.model_config,
    });
    if (!updated) throw notFound(`agent ${id} not found`);
    return jsonOk(updated);
  });
}

export function handleDeleteAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedAgentTenant(auth, id);
      const res = await forwardToAnthropic(request, `/v1/agents/${id}`);
      if (res.ok) unmarkProxied(id);
      return res;
    }
    loadAgentForCaller(auth, id); // tenant guard — throws 404 on cross-tenant
    const ok = archiveAgent(id);
    if (!ok) throw notFound(`agent ${id} not found`);
    return jsonOk({ id, type: "agent_deleted" });
  });
}
