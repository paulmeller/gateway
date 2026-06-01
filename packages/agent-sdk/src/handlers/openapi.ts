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
 *   GET /anthropic/v1/openapi.json            → Anthropic-shaped only
 *   GET /agentstep/v1/openapi.json            → Gateway-native only (canonical, NEW)
 *   GET /google/v1beta/openapi.json           → Google-compat only
 *
 * `/v1/openapi.json` is the combined view: every route on every
 * surface. Kept indefinitely as the back-compat entrypoint for
 * integrations (Swagger UI, postman imports) that fetch it expecting
 * everything. Per-surface specs let code generators target a single
 * surface (`--spec /anthropic/v1/openapi.json`) instead of filtering
 * client-side.
 *
 * `/agentstep/v1/openapi.json` is the canonical gateway-native spec
 * (PR8). Paths registered in the registry as `/v1/*` are emitted
 * with the `/agentstep/v1/*` prefix on this surface — the URL
 * migration is reflected at the doc level so new tooling sees only
 * the canonical paths.
 *
 * `?all=true` on a per-surface endpoint forces the combined view —
 * an escape hatch we don't expect anyone to need but is cheap to keep.
 */
function inferPathPrefix(request: Request): string | undefined {
  const url = new URL(request.url);
  if (url.searchParams.get("all") === "true") return undefined;
  if (url.pathname.startsWith("/anthropic/v1/")) return "/anthropic/v1";
  if (url.pathname.startsWith("/agentstep/v1/")) return "/agentstep/v1";
  if (url.pathname.startsWith("/google/v1beta/")) return "/google/v1beta";
  return undefined;
}

export async function handleGetOpenApiSpec(request: Request): Promise<Response> {
  const serverUrl = originFromRequest(request);
  const pathPrefix = inferPathPrefix(request);
  const doc = buildOpenApiDocument({ serverUrl, pathPrefix });
  return Response.json(doc);
}
