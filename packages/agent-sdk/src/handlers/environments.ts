import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { getDb } from "../db/client";
import {
  createEnvironment,
  getEnvironment,
  listEnvironments,
  archiveEnvironment,
  deleteEnvironment,
  hasSessionsAttached,
  updateEnvironment,
} from "../db/environments";
import { kickoffEnvironmentSetup } from "../containers/setup";
import { resolveContainerProvider as resolveProvider } from "../providers/registry";
import { isProxied, markProxied, unmarkProxied, getProxiedTenantId } from "../db/proxy";
import { forwardToAnthropic } from "../proxy/forward";
import { badRequest, conflict, notFound } from "../errors";
import { assertResourceTenant, resolveCreateTenant, tenantFilter } from "../auth/scope";
import type { AuthContext } from "../types";

function getEnvironmentTenantId(id: string): string | null | undefined {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM environments WHERE id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

function loadEnvForCaller(auth: AuthContext, id: string) {
  const tenantId = getEnvironmentTenantId(id);
  if (tenantId === undefined) throw notFound(`environment ${id} not found`);
  assertResourceTenant(auth, tenantId, `environment ${id} not found`);
  const env = getEnvironment(id);
  if (!env) throw notFound(`environment ${id} not found`);
  return env;
}

/**
 * Tenant guard for proxied environments. Same rationale as
 * assertProxiedAgentTenant in agents.ts.
 */
function assertProxiedEnvTenant(auth: AuthContext, id: string): void {
  const proxied = getProxiedTenantId(id);
  if (proxied === undefined) return;
  assertResourceTenant(auth, proxied, `environment ${id} not found`);
}

const PackagesSchema = z
  .object({
    apt: z.array(z.string()).optional(),
    cargo: z.array(z.string()).optional(),
    gem: z.array(z.string()).optional(),
    go: z.array(z.string()).optional(),
    npm: z.array(z.string()).optional(),
    pip: z.array(z.string()).optional(),
  })
  .optional();

const NetworkingSchema = z.union([
  z.object({ type: z.literal("unrestricted") }),
  z.object({
    type: z.literal("limited"),
    allowed_hosts: z.array(z.string()).optional(),
    allow_mcp_servers: z.boolean().optional(),
    allow_package_managers: z.boolean().optional(),
  }),
]);

const ConfigSchema = z.object({
  type: z.literal("cloud"),
  provider: z.enum(["sprites", "docker", "apple-container", "apple-firecracker", "podman", "e2b", "vercel", "daytona", "fly", "modal", "mvm", "anthropic"]).optional(),
  packages: PackagesSchema,
  networking: NetworkingSchema.optional(),
});

const CreateSchema = z.object({
  name: z.string().min(1),
  config: ConfigSchema,
  description: z.string().optional().nullable(),
  metadata: z.record(z.string()).optional(),
  backend: z.enum(["anthropic"]).optional(),
  /** v0.5: required for global admin, ignored for tenant users. */
  tenant_id: z.string().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  metadata: z.record(z.string()).optional(),
  config: ConfigSchema.optional(),
});

export function handleCreateEnvironment(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) : null;
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    // Resolve tenant up-front so both the proxy and local paths can
    // stamp it on any created resources.
    const createTenantId = resolveCreateTenant(auth, parsed.data.tenant_id);

    if (parsed.data.backend === "anthropic") {
      const { backend: _, ...rest } = body as Record<string, unknown>;
      const forwardBody = JSON.stringify(rest);
      const proxyRes = await forwardToAnthropic(request, "/v1/environments", { body: forwardBody });
      if (proxyRes.ok) {
        try {
          const data = (await proxyRes.clone().json()) as { id: string };
          markProxied(data.id, "environment", createTenantId);
        } catch { /* best-effort */ }
      }
      return proxyRes;
    }

    // Check for duplicate name within the caller's tenant scope.
    const existingEnvs = listEnvironments({ limit: 1000, tenantFilter: tenantFilter(auth) });
    if (existingEnvs.some(e => e.name === parsed.data.name)) {
      throw conflict(`Environment with name "${parsed.data.name}" already exists`);
    }

    // Pre-flight: check provider is available before creating the environment
    // Skip for cloud providers — their API keys are configured separately (vaults/secrets)
    const providerName = parsed.data.config.provider ?? "sprites";
    const CLOUD_PROVIDERS = new Set(["sprites", "e2b", "vercel", "daytona", "fly", "modal", "anthropic"]);
    if (!CLOUD_PROVIDERS.has(providerName)) {
      const provider = await resolveProvider(providerName);
      if (provider.checkAvailability) {
        const result = await provider.checkAvailability();
        if (!result.available) {
          throw badRequest(`Provider "${providerName}" is not available: ${result.message}`);
        }
      }
    }

    const env = createEnvironment({
      name: parsed.data.name,
      config: parsed.data.config,
      description: parsed.data.description ?? null,
      metadata: parsed.data.metadata,
      tenant_id: createTenantId,
    });

    kickoffEnvironmentSetup(env.id);
    return jsonOk(env, 201);
  });
}

export function handleListEnvironments(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit");
    const order = url.searchParams.get("order") as "asc" | "desc" | null;
    const includeArchived = url.searchParams.get("include_archived") === "true";
    const cursor = url.searchParams.get("page") ?? undefined;

    const data = listEnvironments({
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

export function handleGetEnvironment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedEnvTenant(auth, id);
      return forwardToAnthropic(request, `/v1/environments/${id}`);
    }
    return jsonOk(loadEnvForCaller(auth, id));
  });
}

export function handleDeleteEnvironment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedEnvTenant(auth, id);
      const res = await forwardToAnthropic(request, `/v1/environments/${id}`);
      if (res.ok) unmarkProxied(id);
      return res;
    }
    loadEnvForCaller(auth, id); // tenant guard
    if (hasSessionsAttached(id)) {
      throw conflict(`Cannot delete: environment has active sessions. Archive or delete sessions first.`);
    }
    deleteEnvironment(id);
    return jsonOk({ id, type: "environment_deleted" });
  });
}

export function handleArchiveEnvironment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedEnvTenant(auth, id);
      const res = await forwardToAnthropic(request, `/v1/environments/${id}/archive`);
      if (res.ok) unmarkProxied(id);
      return res;
    }
    loadEnvForCaller(auth, id); // tenant guard
    if (hasSessionsAttached(id)) {
      throw conflict(`environment ${id} still has active sessions attached`);
    }
    archiveEnvironment(id);
    const env = getEnvironment(id)!;
    return jsonOk(env);
  });
}

export function handleUpdateEnvironment(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedEnvTenant(auth, id);
      return forwardToAnthropic(request, `/v1/environments/${id}`, {
        body: await request.text(),
      });
    }
    loadEnvForCaller(auth, id); // tenant guard

    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) : null;
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const updated = updateEnvironment(id, {
      name: parsed.data.name,
      description: parsed.data.description,
      metadata: parsed.data.metadata,
      config: parsed.data.config,
    });
    return jsonOk(updated!);
  });
}
