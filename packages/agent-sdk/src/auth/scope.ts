/**
 * Scope + admin enforcement helpers for virtual keys.
 *
 * v0.4 model:
 *   - AuthContext.permissions = { admin, scope }
 *   - scope === null → unrestricted (equivalent to every resource array = ["*"])
 *   - scope !== null → each resource type (agents, environments, vaults) is an
 *     allow-list. "*" in an array means "all of this type".
 *   - permissions.admin === true → may CRUD keys and other admin-only endpoints.
 *
 * v0.5 will add a tenant precondition before scope check. AuthContext.tenantId
 * is already exposed but unused in v0.4.
 */
import type { AuthContext } from "../types";
import { forbidden, notFound } from "../errors";

/** Throws 403 unless the caller is an admin (global or tenant). */
export function requireAdmin(auth: AuthContext): void {
  if (!auth.permissions.admin) {
    throw forbidden("admin permission required");
  }
}

/** Throws 403 unless the caller is a global admin (null tenant + admin). */
export function requireGlobalAdmin(auth: AuthContext): void {
  if (!auth.isGlobalAdmin) {
    throw forbidden("global admin permission required");
  }
}

/**
 * The tenant id the request is operating on, resolving the
 * `x-agentstep-tenant` header on top of the key's own tenant.
 *
 *   1. `actingAsTenant` (validated header) wins when present.
 *   2. Otherwise fall back to the key's own `tenantId`.
 *   3. Null = global-admin "see everything" mode (no impersonation).
 *
 * Every tenant-scoped read/write helper in this file routes through
 * this so the header is honored uniformly. The middleware has already
 * authorized the header against the key — by the time we read it here
 * we can trust `actingAsTenant`.
 */
export function effectiveTenant(auth: AuthContext): string | null {
  if (auth.actingAsTenant) return auth.actingAsTenant;
  return auth.tenantId;
}

/**
 * The tenant filter to apply to a list/get query.
 *
 * - Global admin (null tenant + admin) → `null` = no filter, see everything.
 * - Tenant admin/user → their tenantId, which callers append as
 *   `WHERE tenant_id = ?`.
 *
 * Anything not global-admin is tenant-filtered, even if the caller has
 * admin rights within their tenant. This is the whole point of tenancy.
 */
export function tenantFilter(auth: AuthContext): string | null {
  // Header impersonation comes first: a global admin acting as a tenant
  // narrows visibility to that tenant; without it, global admin still
  // sees everything (null filter).
  if (auth.actingAsTenant) return auth.actingAsTenant;
  if (auth.isGlobalAdmin) return null;
  return auth.tenantId;
}

/**
 * Assert the resource's `tenant_id` matches the caller's effective tenant
 * (or the caller is a global admin operating without impersonation).
 * Throws 404 (not 403) on mismatch so callers can't probe resource IDs
 * from other tenants.
 *
 * Precedence order matters: `effectiveTenant()` is consulted BEFORE
 * the global-admin bypass. Reading the bypass first would let a global
 * admin's service key still see every tenant's resources even after the
 * product sets the `x-agentstep-tenant` header — defeating the entire
 * scoping mechanism.
 */
export function assertResourceTenant(
  auth: AuthContext,
  resourceTenantId: string | null,
  notFoundMsg: string,
): void {
  const acting = effectiveTenant(auth);
  if (acting !== null) {
    if (resourceTenantId === acting) return;
    throw notFound(notFoundMsg);
  }
  // No effective tenant — only a global admin (no impersonation) reaches
  // here. They see everything.
  if (auth.isGlobalAdmin) return;
  throw notFound(notFoundMsg);
}

/**
 * Stamp the tenant_id for a CREATE operation from the caller's auth
 * context. Rules:
 *
 *   - Global admin + body.tenant_id given → use it (may pick any tenant).
 *   - Global admin + no body.tenant_id    → default tenant. Preserves
 *     the pre-0.5 UX where a legacy `["*"]` seed key transparently
 *     creates resources without needing to know about tenancy.
 *   - Tenant admin/user                    → always their own tenant;
 *     body.tenant_id is ignored (a tenant user can't mint into another
 *     tenant).
 */
export function resolveCreateTenant(
  auth: AuthContext,
  bodyTenantId: string | null | undefined,
): string {
  // Header impersonation (when set) wins. The middleware has already
  // authorized it against the key, so by here `actingAsTenant` is the
  // tenant the caller is allowed to act for.
  if (auth.actingAsTenant) return auth.actingAsTenant;

  if (auth.isGlobalAdmin) {
    // Default to `tenant_default` (seeded on first boot) when unspecified.
    // Avoid importing db/tenants here to prevent a circular require —
    // the id is a plain constant documented in db/tenants.ts.
    // PR6 removes this fallback once the product is sending the header.
    return bodyTenantId ?? "tenant_default";
  }
  // Tenant admin/user — always stamp with their own tenant.
  if (!auth.tenantId) {
    // Defensive: non-global-admin with null tenant is a corrupt auth
    // context. Refuse rather than silently stamp null.
    throw forbidden("this key has no tenant assigned");
  }
  return auth.tenantId;
}

/** True if `id` is present in the allow-list (direct match OR "*" sentinel). */
function allowed(list: string[], id: string): boolean {
  return list.includes("*") || list.includes(id);
}

/**
 * Assert that the caller's scope permits access to the given resources.
 * Pass whichever subset of {agent, env, vaults} applies to the current
 * operation. Undefined fields are not checked.
 *
 * Scope is null (unrestricted) → always pass.
 * Scope is an object → every supplied resource must appear in its list.
 */
export function checkResourceScope(
  auth: AuthContext,
  resources: { agent?: string; env?: string; vaults?: string[] },
): void {
  const { scope } = auth.permissions;
  if (scope === null) return; // unrestricted

  if (resources.agent != null && !allowed(scope.agents, resources.agent)) {
    throw forbidden(`api key scope does not include agent ${resources.agent}`);
  }
  if (resources.env != null && !allowed(scope.environments, resources.env)) {
    throw forbidden(`api key scope does not include environment ${resources.env}`);
  }
  if (resources.vaults && resources.vaults.length > 0) {
    for (const vid of resources.vaults) {
      if (!allowed(scope.vaults, vid)) {
        throw forbidden(`api key scope does not include vault ${vid}`);
      }
    }
  }
}
