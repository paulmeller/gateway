/**
 * Forward a request to Anthropic's hosted Managed Agents API.
 *
 * Swaps the caller's local API key for the server's ANTHROPIC_API_KEY,
 * adds the required `anthropic-beta` header, and pipes the response
 * (including SSE streams) back to the client. Works for both JSON and
 * streaming responses.
 *
 * This is the core of the "anthropic" proxy backend — no sprite, no CLI,
 * no translator. Anthropic owns the resource IDs and handles all execution.
 */
import { getConfig } from "../config";
import { ApiError } from "../errors";

const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";

/**
 * Forward a request to Anthropic. The caller is responsible for
 * authenticating the user against the local API key table (via routeWrap)
 * before calling this.
 *
 * @param request  The original incoming Request (used for method, signal,
 *                 and body reading if opts.body is not provided)
 * @param path     The MA API path (e.g. "/v1/agents" or "/v1/sessions/sess_123/events")
 * @param opts.body Pre-read request body string. Required for POST routes
 *                  that already consumed the body to inspect it (e.g. to
 *                  check `body.backend`). If not provided and method is
 *                  not GET, the body is read from `request.text()`.
 */
export async function forwardToAnthropic(
  request: Request,
  path: string,
  opts?: { body?: string },
): Promise<Response> {
  const cfg = getConfig();
  if (!cfg.anthropicApiKey) {
    throw new ApiError(
      500,
      "server_error",
      "ANTHROPIC_API_KEY is required for the anthropic proxy backend",
    );
  }

  const url = new URL(path, ANTHROPIC_BASE);
  // Preserve query string from the original request
  const origUrl = new URL(request.url);
  url.search = origUrl.search;

  const headers = new Headers();
  headers.set("x-api-key", cfg.anthropicApiKey);
  headers.set("anthropic-beta", BETA_HEADER);

  // Forward select headers from the original request
  const ct = request.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const lastId = request.headers.get("last-event-id");
  if (lastId) headers.set("last-event-id", lastId);
  const idem =
    request.headers.get("idempotency-key") ||
    request.headers.get("Idempotency-Key");
  if (idem) headers.set("idempotency-key", idem);
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);

  // Determine request body
  let body: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = opts?.body ?? (await request.text());
  }

  const res = await fetch(url.toString(), {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  });

  // Pipe response back with original status + headers, stripping hop-by-hop
  const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
  ]);
  const responseHeaders = new Headers();
  for (const [k, v] of res.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) {
      responseHeaders.set(k, v);
    }
  }

  return new Response(res.body, {
    status: res.status,
    headers: responseHeaders,
  });
}

/**
 * Validate that the anthropic proxy can run with the current config.
 * Used at agent-create time and as a belt-and-braces check in the proxy.
 */
export function validateAnthropicProxy(): string | null {
  const cfg = getConfig();
  if (!cfg.anthropicApiKey) {
    return "anthropic proxy backend requires ANTHROPIC_API_KEY to be set";
  }
  return null;
}
