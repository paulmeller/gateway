/**
 * Session resource CRUD handlers.
 *
 * POST   /v1/sessions/:id/resources      — add resource to session
 * GET    /v1/sessions/:id/resources      — list session resources
 * DELETE /v1/sessions/:id/resources/:rid — remove resource
 */
import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { getSession } from "../db/sessions";
import { getDb } from "../db/client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import { badRequest, notFound } from "../errors";
import type { SessionResource } from "../types";

const AddResourceSchema = z.object({
  type: z.enum(["uri", "text", "file", "github_repository"]),
  uri: z.string().optional(),
  content: z.string().optional(),
  file_id: z.string().optional(),
  mount_path: z.string().optional(),
  repository_url: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
});

export function handleAddResource(request: Request, sessionId: string): Promise<Response> {
  return routeWrap(request, async () => {
    const session = getSession(sessionId);
    if (!session) throw notFound(`session not found: ${sessionId}`);

    const body = await request.json();
    const parsed = AddResourceSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const resource: SessionResource = parsed.data;
    const resources = session.resources ?? [];
    resources.push(resource);

    // Update session resources
    const db = getDb();
    db.prepare("UPDATE sessions SET resources_json = ? WHERE id = ?")
      .run(JSON.stringify(resources), sessionId);

    return jsonOk({
      id: `res_${resources.length - 1}`,
      ...resource,
      session_id: sessionId,
      created_at: toIso(nowMs()),
    }, 201);
  });
}

export function handleListResources(request: Request, sessionId: string): Promise<Response> {
  return routeWrap(request, async () => {
    const session = getSession(sessionId);
    if (!session) throw notFound(`session not found: ${sessionId}`);

    const resources = (session.resources ?? []).map((r, i) => ({
      id: `res_${i}`,
      ...r,
      session_id: sessionId,
    }));

    return jsonOk({ data: resources });
  });
}

export function handleDeleteResource(request: Request, sessionId: string, resourceIndex: string): Promise<Response> {
  return routeWrap(request, async () => {
    const session = getSession(sessionId);
    if (!session) throw notFound(`session not found: ${sessionId}`);

    const idx = parseInt(resourceIndex.replace("res_", ""), 10);
    const resources = session.resources ?? [];
    if (isNaN(idx) || idx < 0 || idx >= resources.length) {
      throw notFound(`resource not found: ${resourceIndex}`);
    }

    resources.splice(idx, 1);
    const db = getDb();
    db.prepare("UPDATE sessions SET resources_json = ? WHERE id = ?")
      .run(JSON.stringify(resources), sessionId);

    return jsonOk({ id: resourceIndex, type: "session_resource_deleted" });
  });
}
