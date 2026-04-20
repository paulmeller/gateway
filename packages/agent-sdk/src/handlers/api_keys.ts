/**
 * /v1/api-keys CRUD — admin-only virtual key management.
 *
 * Shape follows the Managed Agents API convention: list/get return hydrated
 * permissions objects; create returns the raw key ONCE then never again.
 *
 * Auth model (v0.4):
 *   - Admin keys (`permissions.admin === true`) can CRUD any key.
 *   - Non-admin keys get 403 on every endpoint in this file.
 *   - Legacy pre-0.4 keys with `["*"]` permissions are treated as admin
 *     (see hydratePermissions in db/api_keys.ts).
 */
import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { badRequest, forbidden, notFound } from "../errors";
import { assertResourceTenant, requireAdmin, resolveCreateTenant, tenantFilter } from "../auth/scope";
import {
  createApiKey,
  listApiKeys,
  getApiKeyById,
  revokeApiKey,
  updateApiKeyPermissions,
  hydratePermissions,
} from "../db/api_keys";
import { listSessionsByApiKey } from "../db/sessions";
import { getDb } from "../db/client";
import { recordAudit } from "../db/audit";
import { requireFeature, hasFeature, COMMUNITY_LIMITS } from "../license";
import type { AuthContext, KeyPermissions } from "../types";

const ScopeSchema = z.object({
  agents: z.array(z.string()),
  environments: z.array(z.string()),
  vaults: z.array(z.string()),
});

const PermissionsSchema = z.object({
  admin: z.boolean(),
  scope: ScopeSchema.nullable(),
});

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  permissions: PermissionsSchema.optional(),
  tenant_id: z.string().optional(),
});

const PatchBody = z.object({
  permissions: PermissionsSchema,
});

function toView(row: ReturnType<typeof listApiKeys>[number]): {
  id: string;
  name: string;
  prefix: string;
  permissions: KeyPermissions;
  tenant_id: string | null;
  created_at: number;
} {
  return row;
}

/**
 * Load an API key row and enforce caller tenancy. Throws 404 on cross-tenant.
 * Returns the row only when the caller may see it.
 */
function loadKeyForCaller(auth: AuthContext, id: string) {
  const row = getApiKeyById(id);
  if (!row || row.revoked_at != null) throw notFound(`api key ${id} not found`);
  assertResourceTenant(auth, row.tenant_id, `api key ${id} not found`);
  return row;
}

/**
 * Prevent tenant admins from creating admin keys with the admin bit
 * outside their own tenant — and prevent any admin from minting a
 * "global admin" (tenant=null + admin=true) unless they already are one.
 */
function validateKeyCreation(auth: AuthContext, permissions: KeyPermissions, tenantId: string): void {
  // A tenant user can only mint admin keys inside their own tenant.
  // resolveCreateTenant already pins tenantId to auth.tenantId for
  // non-global-admins, so the admin bit is fine there. The only case to
  // block is global-admin minting an admin key with a null tenant but
  // claiming to be scoped — which can't happen because createTenant
  // requires a non-null id. We still defensively refuse admin+null.
  if (permissions.admin && !tenantId) {
    throw badRequest("admin keys must be scoped to a tenant");
  }
  // Only global admins may elevate another key to global admin. We
  // define global-admin as (tenant_id=null && admin=true). Since we
  // require tenantId above, this branch is unreachable in practice but
  // documents the intent.
  if (!auth.isGlobalAdmin && permissions.admin && tenantId !== auth.tenantId) {
    throw forbidden("cannot create admin keys outside your tenant");
  }
}

export function handleCreateApiKey(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    requireAdmin(auth);

    // Community tier: cap at 20 virtual keys. Enterprise: unlimited.
    if (!hasFeature("unlimited_keys")) {
      const existing = listApiKeys({ tenantFilter: tenantFilter(auth) });
      if (existing.length >= COMMUNITY_LIMITS.maxKeys) {
        requireFeature("unlimited_keys", `more than ${COMMUNITY_LIMITS.maxKeys} API keys`);
      }
    }

    const body = await req.json().catch(() => null);
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) {
      throw badRequest(parsed.error.errors.map(e => e.message).join("; "));
    }

    // Default: scoped non-admin unrestricted key. Admin keys are created
    // explicitly by passing `permissions: { admin: true, scope: null }`.
    const permissions: KeyPermissions = parsed.data.permissions ?? {
      admin: false,
      scope: null,
    };

    // Global admins must name a tenant; tenant admins get their own.
    const tenantId = resolveCreateTenant(auth, parsed.data.tenant_id);
    validateKeyCreation(auth, permissions, tenantId);

    const { key, id } = createApiKey({
      name: parsed.data.name,
      permissions,
      tenantId,
    });

    recordAudit({
      auth,
      action: "api_keys.create",
      resource_type: "api_key",
      resource_id: id,
      tenant_id: tenantId,
      metadata: { name: parsed.data.name, admin: permissions.admin },
    });

    // `key` is returned exactly once. The caller must store it.
    return jsonOk({
      id,
      name: parsed.data.name,
      key,
      permissions,
      tenant_id: tenantId,
    }, 201);
  });
}

export function handleListApiKeys(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireAdmin(auth);
    return jsonOk({ data: listApiKeys({ tenantFilter: tenantFilter(auth) }).map(toView) });
  });
}

export function handleGetApiKey(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireAdmin(auth);
    const row = loadKeyForCaller(auth, id);
    return jsonOk({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      permissions: hydratePermissions(row.permissions_json),
      tenant_id: row.tenant_id,
      created_at: row.created_at,
    });
  });
}

export function handlePatchApiKey(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    requireAdmin(auth);
    loadKeyForCaller(auth, id); // tenant guard

    const body = await req.json().catch(() => null);
    const parsed = PatchBody.safeParse(body);
    if (!parsed.success) {
      throw badRequest(parsed.error.errors.map(e => e.message).join("; "));
    }

    const ok = updateApiKeyPermissions(id, parsed.data.permissions);
    if (!ok) throw notFound(`api key ${id} not found`);

    const row = getApiKeyById(id);
    if (!row) throw notFound(`api key ${id} not found`);
    recordAudit({
      auth,
      action: "api_keys.update",
      resource_type: "api_key",
      resource_id: id,
      tenant_id: row.tenant_id,
      metadata: { admin: parsed.data.permissions.admin },
    });
    return jsonOk({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      permissions: hydratePermissions(row.permissions_json),
      tenant_id: row.tenant_id,
      created_at: row.created_at,
    });
  });
}

export function handleRevokeApiKey(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireAdmin(auth);
    const targetRow = loadKeyForCaller(auth, id); // tenant guard + fetch
    // Don't let a key revoke itself — accidentally locking the only admin
    // out of the gateway is a bad UX even if recoverable via SEED_API_KEY.
    if (auth.keyId === id) {
      throw badRequest("cannot revoke the key used for this request");
    }
    const ok = revokeApiKey(id);
    if (!ok) throw notFound(`api key ${id} not found`);
    recordAudit({
      auth,
      action: "api_keys.revoke",
      resource_type: "api_key",
      resource_id: id,
      tenant_id: targetRow.tenant_id,
    });
    return jsonOk({ ok: true, id });
  });
}

/**
 * Per-key activity endpoint for the admin dashboard.
 *
 * Returns recent sessions (newest first, up to 50) plus aggregate totals
 * (session count, total cost, error count) over *all* sessions the key
 * has ever created. Admin-only.
 */
export function handleGetApiKeyActivity(
  request: Request,
  id: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireFeature("per_key_analytics", "per-key cost attribution");
    requireAdmin(auth);
    const row = loadKeyForCaller(auth, id);

    const sessions = listSessionsByApiKey(id, { limit: 50 });

    // Totals across all sessions (not just the returned 50) for this
    // key. Defense-in-depth tenant scope: today a key's sessions
    // always belong to the key's own tenant (enforced at session
    // create), but if that invariant ever slips we still refuse to
    // leak another tenant's totals here.
    const db = getDb();
    const tenantId = tenantFilter(auth);
    const totals = (tenantId != null
      ? db.prepare(
          `SELECT COUNT(*)                         AS session_count,
                  COALESCE(SUM(usage_cost_usd), 0) AS cost_usd,
                  COALESCE(SUM(turn_count), 0)     AS turn_count
             FROM sessions
            WHERE api_key_id = ? AND tenant_id = ?`,
        ).get(id, tenantId)
      : db.prepare(
          `SELECT COUNT(*)                         AS session_count,
                  COALESCE(SUM(usage_cost_usd), 0) AS cost_usd,
                  COALESCE(SUM(turn_count), 0)     AS turn_count
             FROM sessions
            WHERE api_key_id = ?`,
        ).get(id)) as { session_count: number; cost_usd: number; turn_count: number };

    // Error count via events table (consistent with handleGetMetrics).
    const errorRow = (tenantId != null
      ? db.prepare(
          `SELECT COUNT(*) AS error_count
             FROM events e
             JOIN sessions s ON s.id = e.session_id
            WHERE s.api_key_id = ? AND s.tenant_id = ? AND e.type = 'session.error'`,
        ).get(id, tenantId)
      : db.prepare(
          `SELECT COUNT(*) AS error_count
             FROM events e
             JOIN sessions s ON s.id = e.session_id
            WHERE s.api_key_id = ? AND e.type = 'session.error'`,
        ).get(id)) as { error_count: number };

    return jsonOk({
      id,
      name: row.name,
      sessions,
      totals: { ...totals, error_count: errorRow.error_count },
    });
  });
}
