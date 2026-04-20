/**
 * /v1/tenants — global-admin-only tenant CRUD.
 *
 * Tenants are the top-level isolation boundary in v0.5. Only a global
 * admin (null tenant + admin bit) can create, list, or archive tenants;
 * tenant admins can only manage resources within their own tenant, not
 * the tenant itself.
 */
import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { badRequest, notFound } from "../errors";
import { requireGlobalAdmin } from "../auth/scope";
import {
  createTenant,
  getTenant,
  listTenants,
  archiveTenant,
  renameTenant,
} from "../db/tenants";
import { recordAudit } from "../db/audit";
import { requireFeature } from "../license";

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  id: z.string().regex(/^tenant_[a-z0-9_-]+$/i).optional(),
});

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
});

export function handleCreateTenant(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    requireFeature("tenancy", "multi-tenancy");
    requireGlobalAdmin(auth);
    const body = await req.json().catch(() => null);
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) {
      throw badRequest(parsed.error.errors.map((e) => e.message).join("; "));
    }
    try {
      const tenant = createTenant(parsed.data);
      recordAudit({
        auth,
        action: "tenants.create",
        resource_type: "tenant",
        resource_id: tenant.id,
        tenant_id: tenant.id,
        metadata: { name: tenant.name },
      });
      return jsonOk(tenant, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(msg)) {
        throw badRequest("a tenant with this id already exists");
      }
      throw err;
    }
  });
}

export function handleListTenants(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    requireFeature("tenancy", "multi-tenancy");
    requireGlobalAdmin(auth);
    const url = new URL(req.url);
    const includeArchived = url.searchParams.get("include_archived") === "true";
    return jsonOk({ data: listTenants({ includeArchived }) });
  });
}

export function handleGetTenant(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireFeature("tenancy", "multi-tenancy");
    requireGlobalAdmin(auth);
    const tenant = getTenant(id);
    if (!tenant) throw notFound(`tenant ${id} not found`);
    return jsonOk(tenant);
  });
}

export function handlePatchTenant(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    requireFeature("tenancy", "multi-tenancy");
    requireGlobalAdmin(auth);
    const body = await req.json().catch(() => null);
    const parsed = PatchBody.safeParse(body);
    if (!parsed.success) {
      throw badRequest(parsed.error.errors.map((e) => e.message).join("; "));
    }
    let changed = false;
    if (parsed.data.name) {
      const ok = renameTenant(id, parsed.data.name);
      if (!ok) throw notFound(`tenant ${id} not found`);
      changed = true;
    }
    const tenant = getTenant(id);
    if (!tenant) throw notFound(`tenant ${id} not found`);
    // Only audit when something actually changed — empty PATCHes
    // shouldn't pollute the log with noise entries.
    if (changed) {
      recordAudit({
        auth,
        action: "tenants.update",
        resource_type: "tenant",
        resource_id: id,
        tenant_id: id,
        metadata: { new_name: parsed.data.name },
      });
    }
    return jsonOk(tenant);
  });
}

export function handleArchiveTenant(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireFeature("tenancy", "multi-tenancy");
    requireGlobalAdmin(auth);
    const ok = archiveTenant(id);
    if (!ok) {
      throw badRequest(
        `cannot archive tenant ${id} — not found, already archived, or the default tenant`,
      );
    }
    recordAudit({
      auth,
      action: "tenants.archive",
      resource_type: "tenant",
      resource_id: id,
      tenant_id: id,
    });
    return jsonOk({ ok: true, id });
  });
}
