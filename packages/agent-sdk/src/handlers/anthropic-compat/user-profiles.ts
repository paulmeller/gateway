/**
 * HTTP handlers for user profiles (per-user credential scoping).
 */
import { z } from "zod";
import { routeWrap, jsonOk, paginatedOk } from "../../http";
import { badRequest, notFound } from "../../errors";
import { resolveCreateTenant, tenantFilter } from "../../auth/scope";
import {
  createUserProfile,
  getUserProfile,
  listUserProfiles,
  updateUserProfile,
} from "../../db/user-profiles";
import type { TrustGrant } from "../../db/user-profiles";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TrustGrantSchema = z.object({
  type: z.literal("vault_credential"),
  vault_id: z.string().min(1),
  credential_id: z.string().min(1),
});

const CreateSchema = z.object({
  external_id: z.string().max(256).optional(),
  display_name: z.string().max(256).optional(),
  trust_grants: z.array(TrustGrantSchema).max(50).optional(),
});

const UpdateSchema = z.object({
  external_id: z.string().max(256).nullish(),
  display_name: z.string().max(256).nullish(),
  trust_grants: z.array(TrustGrantSchema).max(50).optional(),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleCreateUserProfile(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const body = await request.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(`invalid body: ${parsed.error.issues.map(i => i.message).join("; ")}`);
    }

    const tenantId = resolveCreateTenant(auth, undefined);

    const profile = createUserProfile({
      external_id: parsed.data.external_id,
      display_name: parsed.data.display_name,
      trust_grants: parsed.data.trust_grants as TrustGrant[],
      tenant_id: tenantId,
    });
    return jsonOk(profile, 201);
  });
}

export function handleListUserProfiles(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
    const afterId = url.searchParams.get("after_id") ?? undefined;

    const filter = tenantFilter(auth);
    const result = listUserProfiles({
      tenant_id: filter ?? undefined,
      limit,
      after_id: afterId,
    });

    return paginatedOk(result.data, limit);
  });
}

export function handleGetUserProfile(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const profile = getUserProfile(id);
    if (!profile) throw notFound(`user profile not found: ${id}`);

    // Tenant guard: non-admin users can only see profiles in their tenant
    const filter = tenantFilter(auth);
    if (filter && profile.tenant_id !== filter) {
      throw notFound(`user profile not found: ${id}`);
    }

    return jsonOk(profile);
  });
}

export function handleUpdateUserProfile(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const existing = getUserProfile(id);
    if (!existing) throw notFound(`user profile not found: ${id}`);

    // Tenant guard
    const filter = tenantFilter(auth);
    if (filter && existing.tenant_id !== filter) {
      throw notFound(`user profile not found: ${id}`);
    }

    const body = await request.json().catch(() => null);
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(`invalid body: ${parsed.error.issues.map(i => i.message).join("; ")}`);
    }

    const updated = updateUserProfile(id, {
      external_id: parsed.data.external_id,
      display_name: parsed.data.display_name,
      trust_grants: parsed.data.trust_grants as TrustGrant[] | undefined,
    });
    if (!updated) throw notFound(`user profile not found: ${id}`);
    return jsonOk(updated);
  });
}
