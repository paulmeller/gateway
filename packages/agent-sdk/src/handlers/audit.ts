/**
 * /v1/audit-log — admin-only read-only audit trail.
 *
 * Tenant scoping: global admins see all entries; tenant admins see
 * only entries tagged with their tenant (plus entries they themselves
 * triggered). Tenant users without admin see 403 — nothing here is
 * meant for end-users.
 */
import { routeWrap, jsonOk } from "../http";
import { badRequest } from "../errors";
import { requireAdmin, tenantFilter } from "../auth/scope";
import { listAudit } from "../db/audit";
import type { AuditOutcome } from "../types";

function parseMs(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

const VALID_OUTCOMES = new Set<AuditOutcome>(["success", "denied", "failure"]);

export function handleListAudit(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    requireAdmin(auth);
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit");
    const cursor = url.searchParams.get("page") ?? undefined;
    const action = url.searchParams.get("action") ?? undefined;
    const actorKeyId = url.searchParams.get("actor_key_id") ?? undefined;
    const resourceType = url.searchParams.get("resource_type") ?? undefined;
    const resourceId = url.searchParams.get("resource_id") ?? undefined;
    const outcomeRaw = url.searchParams.get("outcome");
    const createdGte = parseMs(url.searchParams.get("created_at[gte]"));
    const createdLte = parseMs(url.searchParams.get("created_at[lte]"));

    let outcome: AuditOutcome | undefined;
    if (outcomeRaw != null) {
      if (!VALID_OUTCOMES.has(outcomeRaw as AuditOutcome)) {
        throw badRequest(
          `invalid outcome: ${outcomeRaw} (allowed: ${Array.from(VALID_OUTCOMES).join(",")})`,
        );
      }
      outcome = outcomeRaw as AuditOutcome;
    }

    const data = listAudit({
      limit: limit ? Number(limit) : undefined,
      cursor,
      action,
      actor_key_id: actorKeyId,
      resource_type: resourceType,
      resource_id: resourceId,
      outcome,
      createdGte,
      createdLte,
      tenantFilter: tenantFilter(auth),
    });

    return jsonOk({
      data,
      next_page: data.length > 0 ? data[data.length - 1].id : null,
    });
  });
}
