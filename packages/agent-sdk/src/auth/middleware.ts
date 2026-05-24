/**
 * Authentication middleware.
 *
 * Extracts an API key from `x-api-key` (preferred per Managed Agents spec)
 * or `Authorization: Bearer <token>`.
 *
 * Two key spaces:
 *
 *   - Gateway keys (`ck_*` shape) — hashed with sha256 and looked up in
 *     the local `api_keys` table. Returns a normal AuthContext.
 *
 *   - Anthropic API keys (`sk-ant-api*` shape) — when
 *     `anthropic_passthrough_enabled` is true, returns a passthrough
 *     AuthContext that routeWrap forwards directly to Anthropic. Never
 *     compared against the local table; the prefix dispatch ensures the
 *     two spaces can't collide.
 *
 * `sk-ant-oat*` (OAuth tokens) do NOT enter the passthrough path — they
 * fall through to the gateway lookup and 401 (matching the existing
 * anthropic-provider posture in `handlers/sessions.ts`).
 *
 * Callers should prefer `authenticateAndIntercept()` over `authenticate()`
 * directly — the former structurally guarantees the passthrough fast-path
 * runs before any handler code sees the request. Direct `authenticate()`
 * calls bypass the interception and would let a passthrough key fall
 * through to a tenant-scoped handler.
 */
import { findByRawKey, hydratePermissions } from "../db/api_keys";
import { getConfig } from "../config";
import { isAnthropicApiKey, isPassthroughAllowedPath } from "./passthrough";
import { forwardToAnthropic } from "../proxy/forward";
import type { AuthContext } from "../types";
import { unauthorized } from "../errors";

export function extractKey(request: Request): string | null {
  const xKey = request.headers.get("x-api-key");
  if (xKey && xKey.length > 0) return xKey;

  const auth = request.headers.get("authorization") || request.headers.get("Authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1];
  }

  // Fallback: query-param auth for browser-initiated downloads (window.open
  // can't set headers). Only gateway keys (ck_*) are accepted here — never
  // Anthropic passthrough keys which must not appear in URLs/logs.
  try {
    const url = new URL(request.url);
    const qKey = url.searchParams.get("x-api-key");
    if (qKey && qKey.length > 0 && !qKey.startsWith("sk-ant-api")) return qKey;
  } catch { /* invalid URL — skip */ }

  return null;
}

export async function authenticate(request: Request): Promise<AuthContext> {
  const key = extractKey(request);
  if (!key) throw unauthorized();

  // Always perform the local key lookup, even for sk-ant-api* keys, so
  // disabled-passthrough and unknown-gateway-key requests take the same
  // amount of work. Without this, a network attacker could time the
  // 401 to infer whether the passthrough flag is on (sk-ant-api* +
  // flag-off would short-circuit before the sha256+DB hit). The lookup
  // result is discarded for sk-ant-api* keys; the keyspaces don't
  // collide so a hash match for an Anthropic key is impossible.
  const row = findByRawKey(key);

  // Shape-based dispatch: sk-ant-api* keys are *never* looked up in the
  // local api_keys table — they're either passthrough (when enabled) or
  // rejected. This eliminates the "lookup miss reveals which keys exist"
  // side channel and makes the two key spaces strictly disjoint.
  if (isAnthropicApiKey(key)) {
    if (!getConfig().anthropicPassthroughEnabled) throw unauthorized();
    return {
      keyId: "passthrough",
      name: "anthropic-passthrough",
      permissions: { admin: false, scope: null },
      tenantId: null,
      isGlobalAdmin: false,
      budgetUsd: null,
      rateLimitRpm: null,
      spentUsd: 0,
      mode: "passthrough",
      passthroughKey: key,
    };
  }

  if (!row) throw unauthorized();

  const permissions = hydratePermissions(row.permissions_json);
  return {
    keyId: row.id,
    name: row.name,
    permissions,
    tenantId: row.tenant_id,
    // Global admin: null tenant + admin bit. Legacy ["*"] keys hydrate
    // as {admin: true, scope: null} with tenantId still null, so they
    // remain global admins across a 0.4 → 0.5 upgrade. This is the
    // documented default; `gateway tenants migrate-legacy` is the
    // explicit step that changes it.
    isGlobalAdmin: row.tenant_id === null && permissions.admin,
    budgetUsd: row.budget_usd ?? null,
    rateLimitRpm: row.rate_limit_rpm ?? null,
    spentUsd: row.spent_usd ?? 0,
    mode: "gateway",
  };
}

/**
 * Authenticate AND apply the passthrough interception in one call. This
 * is the entry point every protected route handler should use — the
 * return type forces callers to handle the Response branch (used both
 * for passthrough forwarding and for 401-on-disallowed-route).
 *
 * Returns:
 *   - `{ kind: "auth", auth }` — gateway-mode caller; proceed with the
 *     handler body using `auth`.
 *   - `{ kind: "response", response }` — terminal response; return it
 *     directly. Either a passthrough proxy result or a 401 because
 *     a passthrough key tried to reach a gateway-only route.
 *
 * Centralising this keeps the safety invariant ("every authenticated
 * route applies the passthrough fast-path") structural rather than
 * conventional — a future contributor adding a new auth site can't
 * forget the interception, because the type signature gives them no
 * other shape to use.
 */
export async function authenticateAndIntercept(
  request: Request,
): Promise<{ kind: "auth"; auth: AuthContext } | { kind: "response"; response: Response }> {
  const auth = await authenticate(request);
  if (auth.mode !== "passthrough") return { kind: "auth", auth };

  const url = new URL(request.url);
  if (!isPassthroughAllowedPath(url.pathname)) {
    // Passthrough key on a gateway-only route — reject with the same
    // shape as `unauthorized()` would produce, without leaking which
    // route was rejected.
    throw unauthorized();
  }
  const response = await forwardToAnthropic(request, url.pathname, {
    apiKey: auth.passthroughKey,
  });
  return { kind: "response", response };
}
