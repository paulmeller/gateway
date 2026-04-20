/**
 * Authentication middleware.
 *
 * Extracts an API key from `x-api-key` (preferred per Managed Agents spec)
 * or `Authorization: Bearer <token>`. Hashes with sha256 and looks it up in
 * the `api_keys` table. Returns an AuthContext on success.
 */
import { findByRawKey, hydratePermissions } from "../db/api_keys";
import type { AuthContext } from "../types";
import { unauthorized } from "../errors";

export function extractKey(request: Request): string | null {
  const xKey = request.headers.get("x-api-key");
  if (xKey && xKey.length > 0) return xKey;

  const auth = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : null;
}

export async function authenticate(request: Request): Promise<AuthContext> {
  const key = extractKey(request);
  if (!key) throw unauthorized();

  const row = findByRawKey(key);
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
  };
}
