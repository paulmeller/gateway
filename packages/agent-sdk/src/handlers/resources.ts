/**
 * Session resource CRUD handlers.
 *
 * POST   /v1/sessions/:id/resources           — add resource to session
 * GET    /v1/sessions/:id/resources           — list session resources
 * GET    /v1/sessions/:id/resources/:rid      — get single resource
 * DELETE /v1/sessions/:id/resources/:rid      — remove resource
 */
import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { getDb } from "../db/client";
import { getSession, updateSessionResources } from "../db/sessions";
import {
  createResource,
  listResources,
  getResource,
  deleteResource,
  countResources,
} from "../db/session-resources";
import { badRequest, notFound } from "../errors";
import { assertResourceTenant } from "../auth/scope";
import { getProxiedTenantId } from "../db/proxy";
import type { AuthContext } from "../types";

const MAX_RESOURCES_PER_SESSION = 100;

function assertSessionTenant(auth: AuthContext, sessionId: string): void {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
    .get(sessionId) as { tenant_id: string | null } | undefined;
  if (row) {
    assertResourceTenant(auth, row.tenant_id, `session not found: ${sessionId}`);
    return;
  }
  const proxyTenant = getProxiedTenantId(sessionId);
  if (proxyTenant !== undefined) {
    assertResourceTenant(auth, proxyTenant, `session not found: ${sessionId}`);
    return;
  }
  throw notFound(`session not found: ${sessionId}`);
}

const AddResourceSchema = z.object({
  type: z.enum(["uri", "text", "file", "github_repository"]),
  uri: z.string().optional(),
  content: z.string().optional(),
  file_id: z.string().optional(),
  mount_path: z.string().optional(),
  url: z.string().optional(),
  repository_url: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  checkout: z.object({
    type: z.string(),
    name: z.string(),
  }).optional(),
});

export function handleAddResource(request: Request, sessionId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    assertSessionTenant(auth, sessionId);
    const session = getSession(sessionId);
    if (!session) throw notFound(`session not found: ${sessionId}`);

    const body = await request.json();
    const parsed = AddResourceSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    // Enforce 100 resource limit
    const count = countResources(sessionId);
    if (count >= MAX_RESOURCES_PER_SESSION) {
      throw badRequest(`Maximum of ${MAX_RESOURCES_PER_SESSION} resources per session exceeded`);
    }

    const input = parsed.data;
    const resource = createResource(sessionId, input);

    // Also keep resources_json in sync for backward compat
    const resources = session.resources ?? [];
    resources.push({
      type: input.type,
      uri: input.uri,
      content: input.content,
      file_id: input.file_id,
      mount_path: input.mount_path,
      repository_url: input.repository_url ?? input.url,
      branch: input.branch ?? input.checkout?.name,
      commit: input.commit,
    });
    updateSessionResources(sessionId, JSON.stringify(resources));

    return jsonOk(resource, 201);
  });
}

export function handleListResources(request: Request, sessionId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    assertSessionTenant(auth, sessionId);
    const session = getSession(sessionId);
    if (!session) throw notFound(`session not found: ${sessionId}`);

    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") || "100");
    const after_id = url.searchParams.get("after_id") || undefined;
    const before_id = url.searchParams.get("before_id") || undefined;

    const resources = listResources(sessionId, { limit, after_id, before_id });

    return jsonOk({ data: resources });
  });
}

export function handleGetResource(request: Request, sessionId: string, resourceId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    assertSessionTenant(auth, sessionId);

    const resource = getResource(sessionId, resourceId);
    if (!resource) throw notFound(`resource not found: ${resourceId}`);

    return jsonOk(resource);
  });
}

export function handleDeleteResource(request: Request, sessionId: string, resourceId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    assertSessionTenant(auth, sessionId);
    const session = getSession(sessionId);
    if (!session) throw notFound(`session not found: ${sessionId}`);

    const result = deleteResource(sessionId, resourceId);
    if (!result) throw notFound(`resource not found: ${resourceId}`);

    return jsonOk(result);
  });
}
