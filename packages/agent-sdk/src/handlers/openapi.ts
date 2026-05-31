import { buildOpenApiDocument } from "../openapi/spec";

function originFromRequest(request: Request): string {
  const headers = request.headers;
  const proto = headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? new URL(request.url).host;
  return `${proto}://${host}`;
}

/**
 * Infer the path-prefix from the request URL so callers can mount
 * surface-specific spec endpoints:
 *
 *   GET /v1/openapi.json                      → combined (all surfaces, back-compat)
 *   GET /anthropic/v1/openapi.json            → Anthropic-shaped only (NEW)
 *   GET /google/v1beta/openapi.json           → Google-compat only (NEW)
 *
 * `/v1/openapi.json` is kept as the combined view to preserve
 * existing integrations (Swagger UI, postman imports, etc) that
 * fetch it expecting every route on the gateway. The Anthropic-SDK
 * code-generator and similar tooling can target a single surface
 * (`--spec /anthropic/v1/openapi.json`) instead of filtering 107
 * paths down to the ~52 Anthropic-shaped ones client-side.
 *
 * `?all=true` on a per-surface endpoint forces the combined view —
 * an escape hatch we don't expect anyone to need but is cheap to keep.
 */
function inferPathPrefix(request: Request): string | undefined {
  const url = new URL(request.url);
  if (url.searchParams.get("all") === "true") return undefined;
  if (url.pathname.startsWith("/anthropic/v1/")) return "/anthropic/v1";
  if (url.pathname.startsWith("/google/v1beta/")) return "/google/v1beta";
  return undefined;
}

export async function handleGetOpenApiSpec(request: Request): Promise<Response> {
  const serverUrl = originFromRequest(request);
  const pathPrefix = inferPathPrefix(request);
  const doc = buildOpenApiDocument({ serverUrl, pathPrefix });
  return Response.json(doc);
}
