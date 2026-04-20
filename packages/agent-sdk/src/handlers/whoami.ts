/**
 * /v1/whoami — caller-identity inspection.
 *
 * Returns the minimal auth context needed by the UI to decide which
 * controls to show (tenants page, admin-only create-key dialog, etc).
 * Intentionally does NOT expose the key id or prefix — the caller
 * knows their own key; we don't need to echo it.
 */
import { routeWrap, jsonOk } from "../http";

export function handleWhoami(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    return jsonOk({
      name: auth.name,
      tenant_id: auth.tenantId,
      is_global_admin: auth.isGlobalAdmin,
      permissions: auth.permissions,
    });
  });
}
