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
import { badRequest, notFound } from "../errors";
import { requireAdmin } from "../auth/scope";
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
import type { KeyPermissions } from "../types";

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

export function handleCreateApiKey(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    requireAdmin(auth);

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

    const { key, id } = createApiKey({
      name: parsed.data.name,
      permissions,
      tenantId: parsed.data.tenant_id ?? null,
    });

    // `key` is returned exactly once. The caller must store it.
    return jsonOk({
      id,
      name: parsed.data.name,
      key,
      permissions,
      tenant_id: parsed.data.tenant_id ?? null,
    }, 201);
  });
}

export function handleListApiKeys(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireAdmin(auth);
    return jsonOk({ data: listApiKeys().map(toView) });
  });
}

export function handleGetApiKey(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireAdmin(auth);
    const row = getApiKeyById(id);
    if (!row || row.revoked_at != null) throw notFound(`api key ${id} not found`);
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

    const body = await req.json().catch(() => null);
    const parsed = PatchBody.safeParse(body);
    if (!parsed.success) {
      throw badRequest(parsed.error.errors.map(e => e.message).join("; "));
    }

    const ok = updateApiKeyPermissions(id, parsed.data.permissions);
    if (!ok) throw notFound(`api key ${id} not found`);

    const row = getApiKeyById(id);
    if (!row) throw notFound(`api key ${id} not found`);
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
    // Don't let a key revoke itself — accidentally locking the only admin
    // out of the gateway is a bad UX even if recoverable via SEED_API_KEY.
    if (auth.keyId === id) {
      throw badRequest("cannot revoke the key used for this request");
    }
    const ok = revokeApiKey(id);
    if (!ok) throw notFound(`api key ${id} not found`);
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
    requireAdmin(auth);
    const row = getApiKeyById(id);
    if (!row) throw notFound(`api key ${id} not found`);

    const sessions = listSessionsByApiKey(id, { limit: 50 });

    // Totals across all sessions (not just the returned 50) for this key.
    const db = getDb();
    const totals = db
      .prepare(
        `SELECT COUNT(*)                         AS session_count,
                COALESCE(SUM(usage_cost_usd), 0) AS cost_usd,
                COALESCE(SUM(turn_count), 0)     AS turn_count
           FROM sessions
          WHERE api_key_id = ?`,
      )
      .get(id) as { session_count: number; cost_usd: number; turn_count: number };

    // Error count via events table (consistent with handleGetMetrics).
    const errorRow = db
      .prepare(
        `SELECT COUNT(*) AS error_count
           FROM events e
           JOIN sessions s ON s.id = e.session_id
          WHERE s.api_key_id = ? AND e.type = 'session.error'`,
      )
      .get(id) as { error_count: number };

    return jsonOk({
      id,
      name: row.name,
      sessions,
      totals: { ...totals, error_count: errorRow.error_count },
    });
  });
}
