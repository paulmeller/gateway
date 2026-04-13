/**
 * Route helpers: common boilerplate for every /v1 handler.
 *
 * - `ensureInitialized()` runs on first request
 * - `authenticate(request)` extracts + validates the API key
 * - wraps errors into the Managed Agents envelope
 *
 * Framework-agnostic — uses Web Standard Response only.
 */
import { ensureInitialized } from "./init";
import { authenticate } from "./auth/middleware";
import { toResponse } from "./errors";
import type { AuthContext } from "./types";

export interface RouteContext {
  auth: AuthContext;
  request: Request;
}

export async function routeWrap(
  request: Request,
  handler: (ctx: RouteContext) => Promise<Response>,
): Promise<Response> {
  try {
    await ensureInitialized();
    const auth = await authenticate(request);
    return await handler({ auth, request });
  } catch (err) {
    return toResponse(err);
  }
}

export function jsonOk<T>(body: T, status = 200): Response {
  return Response.json(body, { status });
}
