/**
 * Zero-Data-Retention purge engine (PR-Z2 of the #32 epic).
 *
 * `purgeSession({ tenantId, sessionId })` removes every row associated
 * with the session across the per-session tables, unlinks file bytes
 * on disk, recomputes memories.content for any memory whose latest
 * write came from this session, and finally stubs the sessions row.
 * The audit log entry survives.
 *
 * Crash recovery
 * --------------
 *   1. Mark session `status='purging'` + `retention_purged_at=now`
 *      BEFORE any DELETE (the idempotent resume marker).
 *   2. Run destructive work (file unlink first per architect's
 *      ordering review; then batched DELETEs).
 *   3. Stub the row + flip `status='purged'`.
 *
 * Crash anywhere between steps 1 and 3 → boot-time reaper finds
 * status='purging' and re-drives. All steps idempotent: file unlink
 * treats ENOENT as success, DELETEs operate on session_id which is
 * already partially gone.
 *
 * SQLITE_IOERR → process.exit(2). sqlite's in-memory state has
 * diverged from FS; no subsequent SQL is trustworthy.
 *
 * Per-column stub policy (architect's spec)
 * ----------------------------------------
 *   NULL: metadata_json, title, claude_session_id, sandbox_name,
 *         outcome_criteria_json, resources_json, vault_ids_json,
 *         user_profile_id, debug_prompt_json, stop_reason
 *   KEEP: id, tenant_id, agent_id, agent_version, environment_id,
 *         api_key_id, parent_session_id, thread_depth, provider_name,
 *         max_*, archived_at, created_at, updated_at, status,
 *         retention_purged_at, all usage_* + timing counters
 *         (billing/audit defensibility per GDPR Art. 17(3)(e)).
 */
import * as fs from "node:fs";
import { getDb } from "./client";
import { recordAudit } from "./audit";
import { nowMs } from "../util/clock";

export interface PurgeStats {
  events_deleted: number;
  threads_purged: number;
  resources_deleted: number;
  work_items_deleted: number;
  memory_versions_deleted: number;
  memories_recomputed: number;
  memories_orphaned: number;
  files_unlinked: number;
  storage_warnings: string[];
}

/**
 * Batched DELETE that yields between batches so other tenants' writes
 * can progress. Each batch is its own micro-transaction. Returns total
 * rows deleted. On SQLITE_IOERR, aborts the process — sqlite state is
 * unrecoverable in place, the reaper will pick up on boot.
 */
function deleteInBatches(
  table: string,
  whereCol: string,
  whereVal: string,
  batchSize = 1000,
): number {
  const db = getDb();
  let total = 0;
  for (;;) {
    let affected: number;
    try {
      const result = db
        .prepare(
          `DELETE FROM ${table} WHERE rowid IN (
             SELECT rowid FROM ${table} WHERE ${whereCol} = ? LIMIT ?
           )`,
        )
        .run(whereVal, batchSize);
      affected = result.changes;
    } catch (err) {
      if (err instanceof Error && /SQLITE_IOERR|disk I\/O error/i.test(err.message)) {
        console.error(
          `[zdr] SQLITE_IOERR purging ${table} (${whereCol}=${whereVal}); aborting process`,
        );
        process.exit(2);
      }
      throw err;
    }
    total += affected;
    if (affected < batchSize) break;
  }
  return total;
}

/**
 * Recompute memories.content for any memory whose latest version came
 * from the purged session. We identify them via the join: memories
 * whose current content_sha256 doesn't match any surviving
 * memory_versions row. If a surviving version exists, restore from
 * it; otherwise the memory was created by this session and is
 * deleted (memories.content is NOT NULL — deletion is the only
 * correct outcome).
 *
 * Runs AFTER the memory_versions DELETE for the session has run.
 */
function recomputeMemoriesAfterPurge(): { recomputed: number; orphaned: number } {
  const db = getDb();
  const affected = db
    .prepare(
      `SELECT m.id
         FROM memories m
         LEFT JOIN memory_versions mv
           ON mv.memory_id = m.id
          AND mv.content_sha256 = m.content_sha256
        WHERE mv.id IS NULL`,
    )
    .all() as Array<{ id: string }>;

  let recomputed = 0;
  let orphaned = 0;
  for (const { id: memoryId } of affected) {
    const surviving = db
      .prepare(
        `SELECT content, content_sha256
           FROM memory_versions
          WHERE memory_id = ? AND content IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(memoryId) as { content: string; content_sha256: string } | undefined;

    if (surviving) {
      db.prepare(
        `UPDATE memories
            SET content = ?, content_sha256 = ?, updated_at = ?
          WHERE id = ?`,
      ).run(surviving.content, surviving.content_sha256, nowMs(), memoryId);
      recomputed++;
    } else {
      db.prepare(`DELETE FROM memories WHERE id = ?`).run(memoryId);
      orphaned++;
    }
  }
  return { recomputed, orphaned };
}

/**
 * Unlink session-scoped files (scope_type='session' AND scope_id=this).
 * Files scoped to an agent (or unscoped) are NOT touched — they belong
 * to the agent or are global, not session data.
 *
 * Best-effort: ENOENT counts as success; other errors recorded as
 * warnings; purge continues. The DB rows for these files are deleted
 * regardless of disk-unlink outcome (the DB is the source of truth
 * for "purged"; an orphan on disk is a metrics concern, not a
 * correctness one).
 */
function unlinkSessionFiles(sessionId: string): {
  unlinked: number;
  warnings: string[];
} {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, storage_path
         FROM files
        WHERE scope_type = 'session' AND scope_id = ?`,
    )
    .all(sessionId) as Array<{ id: string; storage_path: string }>;

  const warnings: string[] = [];
  let unlinked = 0;

  for (const { id, storage_path } of rows) {
    if (storage_path.startsWith("remote:")) {
      warnings.push(
        `file ${id}: stored remotely at ${storage_path}; AgentStep can't scrub upstream content (customer's separate Anthropic ZDR agreement governs)`,
      );
    } else {
      try {
        fs.unlinkSync(storage_path);
        unlinked++;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          unlinked++; // idempotent — already gone
        } else {
          warnings.push(
            `file ${id} at ${storage_path}: unlink failed (${code ?? err})`,
          );
        }
      }
    }
    try {
      db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
    } catch {
      // session_resources DELETE later will clean up the link rows.
    }
  }

  return { unlinked, warnings };
}

function stubSessionRow(sessionId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE sessions
        SET status                = 'purged',
            stop_reason           = NULL,
            metadata_json         = '{}',
            title                 = NULL,
            claude_session_id     = NULL,
            sandbox_name          = NULL,
            outcome_criteria_json = NULL,
            resources_json        = NULL,
            vault_ids_json        = NULL,
            user_profile_id       = NULL,
            debug_prompt_json     = NULL,
            updated_at            = ?
      WHERE id = ?`,
  ).run(nowMs(), sessionId);
}

/**
 * Tenant guard + resume marker. Returns false if session is already
 * purged (caller should skip). Throws on tenant mismatch — that's a
 * caller bug or a cross-tenant attack attempt; refuse before any
 * destructive op.
 */
function markPurgingStart(tenantId: string, sessionId: string): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT tenant_id, status FROM sessions WHERE id = ?`)
    .get(sessionId) as { tenant_id: string | null; status: string } | undefined;
  if (!row) throw new Error(`zdr.purge: session not found: ${sessionId}`);
  if (row.tenant_id !== tenantId) {
    throw new Error(
      `zdr.purge: tenant mismatch (session belongs to ${row.tenant_id}, caller passed ${tenantId}) — refusing to purge ${sessionId}`,
    );
  }
  if (row.status === "purged") return false;
  db.prepare(
    `UPDATE sessions SET status = 'purging', retention_purged_at = ? WHERE id = ?`,
  ).run(nowMs(), sessionId);
  return true;
}

/**
 * Purge all data associated with a session.
 *
 * Tenant guard is mandatory. Callers MUST supply the tenantId
 * resolved from the request's auth context. Refuses to run on
 * tenant mismatch — line of defense against cross-tenant leakage.
 */
export function purgeSession({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}): PurgeStats {
  const stats: PurgeStats = {
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

  // 1. Tenant guard + resume marker (BEFORE any destructive op)
  if (!markPurgingStart(tenantId, sessionId)) return stats;

  // 2. Recursively purge child threads
  const db = getDb();
  const childRows = db
    .prepare(`SELECT id FROM sessions WHERE parent_session_id = ? AND id != ?`)
    .all(sessionId, sessionId) as Array<{ id: string }>;
  for (const { id: childId } of childRows) {
    const childStats = purgeSession({ tenantId, sessionId: childId });
    stats.threads_purged += 1;
    stats.events_deleted += childStats.events_deleted;
    stats.resources_deleted += childStats.resources_deleted;
    stats.work_items_deleted += childStats.work_items_deleted;
    stats.memory_versions_deleted += childStats.memory_versions_deleted;
    stats.memories_recomputed += childStats.memories_recomputed;
    stats.memories_orphaned += childStats.memories_orphaned;
    stats.files_unlinked += childStats.files_unlinked;
    stats.storage_warnings.push(...childStats.storage_warnings);
  }

  // 3. File unlink BEFORE DB deletes (architect's correctness fix)
  const fileResult = unlinkSessionFiles(sessionId);
  stats.files_unlinked += fileResult.unlinked;
  stats.storage_warnings.push(...fileResult.warnings);

  // 4. Batched DELETEs across per-session tables
  stats.events_deleted += deleteInBatches("events", "session_id", sessionId);
  stats.resources_deleted += deleteInBatches("session_resources", "session_id", sessionId);
  stats.work_items_deleted += deleteInBatches("work_items", "session_id", sessionId);
  stats.memory_versions_deleted += deleteInBatches("memory_versions", "session_id", sessionId);

  // 5. Memory content recompute (NOT NULL constraint forces delete-or-recompute)
  const memResult = recomputeMemoriesAfterPurge();
  stats.memories_recomputed += memResult.recomputed;
  stats.memories_orphaned += memResult.orphaned;

  // 6. Stub the row + flip status='purged'
  stubSessionRow(sessionId);

  // 7. Audit log entry (best-effort, never blocks)
  recordAudit({
    auth: null,
    action: "session.purged",
    resource_type: "session",
    resource_id: sessionId,
    outcome: "success",
    tenant_id: tenantId,
    metadata: {
      events_deleted: stats.events_deleted,
      threads_purged: stats.threads_purged,
      resources_deleted: stats.resources_deleted,
      work_items_deleted: stats.work_items_deleted,
      memory_versions_deleted: stats.memory_versions_deleted,
      memories_recomputed: stats.memories_recomputed,
      memories_orphaned: stats.memories_orphaned,
      files_unlinked: stats.files_unlinked,
      storage_warnings_count: stats.storage_warnings.length,
    },
  });

  return stats;
}

/**
 * Boot-time orphan reaper. Finds sessions left in status='purging'
 * (a previous purge attempt crashed) and re-drives the purge.
 * Best-effort — per-session failures log a warning, don't block boot.
 */
export function reapPurgingSessions(): { reaped: number; failed: number } {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, tenant_id FROM sessions WHERE status = 'purging' LIMIT 1000`)
    .all() as Array<{ id: string; tenant_id: string | null }>;

  let reaped = 0;
  let failed = 0;
  for (const { id, tenant_id } of rows) {
    if (!tenant_id) {
      console.warn(
        `[zdr.reaper] session ${id} in 'purging' but tenant_id NULL — skipping (manual cleanup required)`,
      );
      failed++;
      continue;
    }
    try {
      purgeSession({ tenantId: tenant_id, sessionId: id });
      reaped++;
    } catch (err) {
      console.warn(
        `[zdr.reaper] re-purge failed for ${id}: ${err instanceof Error ? err.message : err}`,
      );
      failed++;
    }
  }
  if (reaped > 0 || failed > 0) {
    console.log(`[zdr.reaper] reaped=${reaped} failed=${failed}`);
  }
  return { reaped, failed };
}
