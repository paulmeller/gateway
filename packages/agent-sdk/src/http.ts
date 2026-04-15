/**
 * Route helpers: common boilerplate for every /v1 handler.
 *
 * - `ensureInitialized()` runs on first request
 * - `authenticate(request)` extracts + validates the API key
 * - wraps errors into the Managed Agents envelope
 * - records request latency + status into the in-process API metrics
 *   recorder for the dashboard's `/v1/metrics/api` endpoint
 *
 * Framework-agnostic — uses Web Standard Response only.
 */
import { ensureInitialized } from "./init";
import { authenticate } from "./auth/middleware";
import { toResponse, ApiError } from "./errors";
import { captureException } from "./sentry";
import { recordApiRequest, normalizeRoute } from "./observability/api-metrics";
import type { AuthContext } from "./types";

export interface RouteContext {
  auth: AuthContext;
  request: Request;
}

export async function routeWrap(
  request: Request,
  handler: (ctx: RouteContext) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  let status = 500;
  try {
    await ensureInitialized();
    const auth = await authenticate(request);
    const res = await handler({ auth, request });
    status = res.status;
    return res;
  } catch (err) {
    // Report unexpected errors to Sentry (skip expected API errors like 400/404)
    if (!(err instanceof ApiError) || err.status >= 500) {
      captureException(err);
    }
    const res = toResponse(err);
    status = res.status;
    return res;
  } finally {
    // Record the request into the in-process API metrics recorder.
    // Must never throw — the metrics path is best-effort.
    try {
      const route = normalizeRoute(request.url);
      recordApiRequest(route, Date.now() - startedAt, status);
    } catch {
      /* best-effort */
    }
  }
}

export function jsonOk<T>(body: T, status = 200): Response {
  return Response.json(body, { status });
}
