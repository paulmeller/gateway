/**
 * Stub handlers for standalone skill CRUD endpoints.
 *
 * Anthropic's API supports standalone skill objects (POST /v1/skills, DELETE /v1/skills/:id).
 * The gateway stores skills inline on agent_versions.skills_json, so standalone CRUD
 * is not yet supported. These stubs return 501 with a helpful message instead of 404.
 */
import { routeWrap } from "../http";
import { ApiError } from "../errors";

export function handleCreateSkill(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    throw new ApiError(501, "server_error",
      "Standalone skill creation is not yet supported. " +
      "Add skills directly to agents via POST/PATCH /v1/agents with the skills[] field.");
  });
}

export function handleDeleteSkill(request: Request, _id: string): Promise<Response> {
  return routeWrap(request, async () => {
    throw new ApiError(501, "server_error",
      "Standalone skill deletion is not yet supported. " +
      "Remove skills from agents via PATCH /v1/agents.");
  });
}
