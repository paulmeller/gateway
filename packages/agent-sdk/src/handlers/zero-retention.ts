/**
 * Retroactive ZDR purge admin handler (PR-Z3).
 *
 * When a customer flips `environment.config.zero_data_retention=true`
 * on an env that already has sessions, the immutability contract
 * (PR-Z1) means those existing sessions retain their original
 * non-ZDR flag — toggling the env doesn't retroactively purge them.
 *
 * This handler is the explicit escape hatch.
 *
 *   POST /agentstep/v1/environments/{id}/purge-existing
 *     Body: { confirm?: boolean }
 *
 *   confirm=false (default): dry-run, returns counts only.
 *   confirm=true: iterates sessions in the env calling purgeSession.
 *
 * Auth: global-admin only — destructive enough that we want the
 * audit trail to record a specific global admin, not any tenant
 * admin who happens to control the env.
 */
import { routeWrap, jsonOk } from "../http";
import { badRequest, notFound } from "../errors";
import { requireGlobalAdmin } from "../auth/scope";
import { getDb } from "../db/client";
import { getEnvironment } from "../db/environments";
import { purgeSession, type PurgeStats } from "../db/zero-retention";
import { recordAudit } from "../db/audit";

interface PurgeExistingRequestBody {
  confirm?: boolean;
}

interface SessionToList {
  id: string;
  tenant_id: string | null;
  status: string;
}

export function handlePurgeEnvironmentExisting(
  request: Request,
  envId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    requireGlobalAdmin(auth);

    const env = getEnvironment(envId);
    if (!env) throw notFound(`environment not found: ${envId}`);

    const raw = await request.text();
    let body: PurgeExistingRequestBody = {};
    if (raw) {
      try {
        body = JSON.parse(raw) as PurgeExistingRequestBody;
      } catch {
        throw badRequest("body must be JSON (or empty)");
      }
    }
    const confirm = body.confirm === true;

    const db = getDb();
    const sessions = db
      .prepare(
        `SELECT id, tenant_id, status
           FROM sessions
          WHERE environment_id = ?
            AND status NOT IN ('purged', 'purging')
          LIMIT 5000`,
      )
      .all(envId) as SessionToList[];

    if (!confirm) {
      return jsonOk({
        type: "purge_existing_dry_run",
        environment_id: envId,
        session_count: sessions.length,
        would_purge: true,
        hint: 'POST again with body {"confirm": true} to execute',
      });
    }

    const aggregate: PurgeStats = {
      events_deleted: 0,
      threads_purged: 0,
      resources_deleted: 0,
      work_items_deleted: 0,
      memory_versions_deleted: 0,
      memories_recomputed: 0,
      memories_orphaned: 0,
      files_unlinked: 0,
      storage_warnings: [],
    };
    let purged_count = 0;
    let failed_count = 0;
    const failed_ids: string[] = [];

    for (const session of sessions) {
      if (!session.tenant_id) {
        failed_count++;
        failed_ids.push(session.id);
        continue;
      }
      try {
        const stats = purgeSession({
          tenantId: session.tenant_id,
          sessionId: session.id,
        });
        purged_count++;
        aggregate.events_deleted += stats.events_deleted;
        aggregate.threads_purged += stats.threads_purged;
        aggregate.resources_deleted += stats.resources_deleted;
        aggregate.work_items_deleted += stats.work_items_deleted;
        aggregate.memory_versions_deleted += stats.memory_versions_deleted;
        aggregate.memories_recomputed += stats.memories_recomputed;
        aggregate.memories_orphaned += stats.memories_orphaned;
        aggregate.files_unlinked += stats.files_unlinked;
        aggregate.storage_warnings.push(...stats.storage_warnings);
      } catch (err) {
        console.warn(
          `[zdr.purge-existing] failed to purge session ${session.id}: ${err instanceof Error ? err.message : err}`,
        );
        failed_count++;
        failed_ids.push(session.id);
      }
    }

    recordAudit({
      auth,
      action: "environment.purge_existing",
      resource_type: "environment",
      resource_id: envId,
      // AuditOutcome is `"success" | "denied" | "failure"`. Anything
      // less than fully-clean counts as "failure" — the count of
      // failed sessions is in metadata.
      outcome: failed_count === 0 ? "success" : "failure",
      metadata: {
        sessions_considered: sessions.length,
        purged_count,
        failed_count,
        events_deleted: aggregate.events_deleted,
        threads_purged: aggregate.threads_purged,
        resources_deleted: aggregate.resources_deleted,
        work_items_deleted: aggregate.work_items_deleted,
        memory_versions_deleted: aggregate.memory_versions_deleted,
        memories_recomputed: aggregate.memories_recomputed,
        memories_orphaned: aggregate.memories_orphaned,
        files_unlinked: aggregate.files_unlinked,
        storage_warnings_count: aggregate.storage_warnings.length,
        failed_ids_sample: failed_ids.slice(0, 10),
      },
    });

    return jsonOk({
      type: "purge_existing_result",
      environment_id: envId,
      session_count: sessions.length,
      purged_count,
      failed_count,
      stats: aggregate,
    });
  });
}
