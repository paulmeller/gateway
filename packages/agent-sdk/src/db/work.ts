import { eq, and, sql } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { WorkItem, WorkState, WorkQueueStats } from "../types";

const LEASE_TTL_MS = 60_000; // 60 seconds

// ── Hydrate ──────────────────────────────────────────────────────────────

function hydrate(row: Record<string, unknown>): WorkItem {
  const metadata: Record<string, string> = row.metadata_json
    ? (JSON.parse(row.metadata_json as string) as Record<string, string>)
    : {};

  return {
    type: "work",
    id: row.id as string,
    environment_id: row.environment_id as string,
    state: row.state as WorkState,
    data: { type: "session", id: row.session_id as string },
    metadata,
    worker_id: (row.worker_id as string) ?? null,
    created_at: toIso(row.created_at as number),
    acknowledged_at: row.acknowledged_at ? toIso(row.acknowledged_at as number) : null,
    started_at: row.started_at ? toIso(row.started_at as number) : null,
    latest_heartbeat_at: row.latest_heartbeat_at ? toIso(row.latest_heartbeat_at as number) : null,
    stop_requested_at: row.stop_requested_at ? toIso(row.stop_requested_at as number) : null,
    stopped_at: row.stopped_at ? toIso(row.stopped_at as number) : null,
  };
}

// ── Create ───────────────────────────────────────────────────────────────

export function createWorkItem(
  envId: string,
  sessionId: string,
  opts?: { inputsJson?: string; tenantId?: string },
): WorkItem {
  const db = getDrizzle();
  const id = newId("work");
  const now = nowMs();

  db.insert(schema.workItems)
    .values({
      id,
      environment_id: envId,
      session_id: sessionId,
      state: "queued",
      inputs_json: opts?.inputsJson ?? null,
      metadata_json: "{}",
      tenant_id: opts?.tenantId ?? null,
      created_at: now,
    })
    .run();

  return getWorkItem(id)!;
}

// ── Get ──────────────────────────────────────────────────────────────────

export function getWorkItem(id: string): WorkItem | undefined {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.workItems)
    .where(eq(schema.workItems.id, id))
    .get() as Record<string, unknown> | undefined;
  return row ? hydrate(row) : undefined;
}

// ── Get (internal — includes inputs_json for worker) ────────────────

/**
 * Returns the raw `inputs_json` string for a work item.
 * This is an internal-only helper consumed by the co-located worker;
 * the field is intentionally excluded from the public WorkItem type.
 */
export function getWorkItemInputs(id: string): string | null {
  const db = getDrizzle();
  const row = db
    .select({ inputs_json: schema.workItems.inputs_json })
    .from(schema.workItems)
    .where(eq(schema.workItems.id, id))
    .get() as { inputs_json: string | null } | undefined;
  return row?.inputs_json ?? null;
}

// ── List ─────────────────────────────────────────────────────────────────

export function listWorkItems(
  envId: string,
  opts?: { limit?: number; cursor?: string; state?: WorkState },
): WorkItem[] {
  const db = getDrizzle();
  const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100);

  const conditions: ReturnType<typeof eq>[] = [
    eq(schema.workItems.environment_id, envId),
  ];

  if (opts?.state) {
    conditions.push(eq(schema.workItems.state, opts.state));
  }

  if (opts?.cursor) {
    conditions.push(sql`${schema.workItems.created_at} < (SELECT created_at FROM work_items WHERE id = ${opts.cursor})` as ReturnType<typeof eq>);
  }

  const rows = db
    .select()
    .from(schema.workItems)
    .where(and(...conditions))
    .orderBy(sql`${schema.workItems.created_at} DESC`)
    .limit(limit)
    .all() as Record<string, unknown>[];

  return rows.map(hydrate);
}

// ── Atomic Poll ──────────────────────────────────────────────────────────

export function pollWorkItem(envId: string, workerId?: string): WorkItem | null {
  const db = getDrizzle();
  const now = nowMs();

  // 1. Reclaim expired leases — push them back to 'queued'
  db.run(
    sql`UPDATE work_items
        SET state = 'queued', worker_id = NULL, lease_expires_at = NULL
        WHERE state IN ('pending', 'active')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < ${now}`,
  );

  // 2. Atomic claim: single UPDATE with subquery
  const leaseExpires = now + LEASE_TTL_MS;
  const wid = workerId ?? null;

  const result = db.run(
    sql`UPDATE work_items
        SET state = 'pending',
            worker_id = ${wid},
            lease_expires_at = ${leaseExpires}
        WHERE id = (
          SELECT id FROM work_items
          WHERE environment_id = ${envId} AND state = 'queued'
          ORDER BY created_at ASC LIMIT 1
        )
        AND state = 'queued'`,
  );

  if (result.changes === 0) return null;

  // 3. Fetch the claimed item — it's the one with our lease_expires_at + worker_id
  //    Use a raw query to find the exact row we just claimed.
  const rows = db.all(
    sql`SELECT * FROM work_items
        WHERE environment_id = ${envId}
          AND state = 'pending'
          AND lease_expires_at = ${leaseExpires}
          AND worker_id IS ${wid}
        ORDER BY created_at ASC LIMIT 1`,
  ) as Record<string, unknown>[];

  if (rows.length === 0) return null;
  return hydrate(rows[0]);
}

// ── Acknowledge ──────────────────────────────────────────────────────────

export function ackWorkItem(id: string, workerId?: string): WorkItem | undefined {
  const db = getDrizzle();
  const now = nowMs();
  const leaseExpires = now + LEASE_TTL_MS;

  const conditions = [eq(schema.workItems.id, id), eq(schema.workItems.state, "pending")];

  const res = db
    .update(schema.workItems)
    .set({
      state: "active",
      worker_id: workerId ?? undefined,
      acknowledged_at: now,
      started_at: now,
      lease_expires_at: leaseExpires,
    })
    .where(and(...conditions))
    .run();

  if (res.changes === 0) return undefined;
  return getWorkItem(id);
}

// ── Heartbeat ────────────────────────────────────────────────────────────

export function heartbeatWorkItem(id: string): {
  type: "work_heartbeat";
  last_heartbeat: string;
  lease_extended: boolean;
  state: WorkState;
  ttl_seconds: number;
} | undefined {
  const db = getDrizzle();
  const item = getWorkItem(id);
  if (!item) return undefined;

  const now = nowMs();

  // If completed or failed, don't extend the lease
  if (item.state === "completed" || item.state === "failed") {
    return {
      type: "work_heartbeat",
      last_heartbeat: toIso(now),
      lease_extended: false,
      state: item.state,
      ttl_seconds: 0,
    };
  }

  const leaseExpires = now + LEASE_TTL_MS;

  db.update(schema.workItems)
    .set({
      latest_heartbeat_at: now,
      lease_expires_at: leaseExpires,
    })
    .where(eq(schema.workItems.id, id))
    .run();

  return {
    type: "work_heartbeat",
    last_heartbeat: toIso(now),
    lease_extended: true,
    state: item.state,
    ttl_seconds: LEASE_TTL_MS / 1000,
  };
}

// ── Complete ─────────────────────────────────────────────────────────────

export function completeWorkItem(
  id: string,
  state: "completed" | "failed",
): WorkItem | undefined {
  const db = getDrizzle();
  const now = nowMs();

  const res = db
    .update(schema.workItems)
    .set({
      state,
      stopped_at: now,
      lease_expires_at: null,
    })
    .where(eq(schema.workItems.id, id))
    .run();

  if (res.changes === 0) return undefined;
  return getWorkItem(id);
}

// ── Stop ─────────────────────────────────────────────────────────────────

export function stopWorkItem(id: string, force?: boolean): WorkItem | undefined {
  const db = getDrizzle();
  const now = nowMs();

  if (force) {
    const res = db
      .update(schema.workItems)
      .set({
        state: "failed",
        stop_requested_at: now,
        stopped_at: now,
        lease_expires_at: null,
      })
      .where(eq(schema.workItems.id, id))
      .run();
    if (res.changes === 0) return undefined;
  } else {
    const res = db
      .update(schema.workItems)
      .set({ stop_requested_at: now })
      .where(eq(schema.workItems.id, id))
      .run();
    if (res.changes === 0) return undefined;
  }

  return getWorkItem(id);
}

// ── Update Metadata ──────────────────────────────────────────────────────

export function updateWorkItemMetadata(
  id: string,
  metadata: Record<string, string | null>,
): WorkItem | undefined {
  const db = getDrizzle();
  const item = getWorkItem(id);
  if (!item) return undefined;

  // Merge: null values delete keys
  const merged = { ...item.metadata };
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  db.update(schema.workItems)
    .set({ metadata_json: JSON.stringify(merged) })
    .where(eq(schema.workItems.id, id))
    .run();

  return getWorkItem(id);
}

// ── Queue Stats ──────────────────────────────────────────────────────────

export function getWorkQueueStats(envId: string): WorkQueueStats {
  const db = getDrizzle();

  const rows = db.all(
    sql`SELECT state, COUNT(*) as cnt
        FROM work_items
        WHERE environment_id = ${envId}
        GROUP BY state`,
  ) as Array<{ state: string; cnt: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.state] = row.cnt;
  }

  const depth = counts["queued"] ?? 0;
  const pending = (counts["pending"] ?? 0) + (counts["active"] ?? 0);

  // Oldest queued item timestamp
  const oldestRow = db.all(
    sql`SELECT MIN(created_at) as oldest
        FROM work_items
        WHERE environment_id = ${envId} AND state = 'queued'`,
  ) as Array<{ oldest: number | null }>;
  const oldestQueuedAt = oldestRow[0]?.oldest ? toIso(oldestRow[0].oldest) : null;

  // Workers polling: distinct worker IDs from active/pending items
  const workerRows = db.all(
    sql`SELECT COUNT(DISTINCT worker_id) as cnt
        FROM work_items
        WHERE environment_id = ${envId}
          AND state IN ('pending', 'active')
          AND worker_id IS NOT NULL`,
  ) as Array<{ cnt: number }>;
  const workersPollling = workerRows[0]?.cnt ?? 0;

  return {
    type: "work_queue_stats",
    depth,
    pending,
    workers_polling: workersPollling > 0 ? workersPollling : null,
    oldest_queued_at: oldestQueuedAt,
  };
}
