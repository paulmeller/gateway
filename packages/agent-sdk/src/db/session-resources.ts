/**
 * Session resources CRUD.
 *
 * Resources are stored in the `session_resources` table (one row per resource).
 * This replaces the legacy `resources_json` column on sessions.
 */
import { eq, and, desc, gt, lt, sql } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionResourceRow {
  id: string;
  session_id: string;
  type: string;
  file_id: string | null;
  mount_path: string | null;
  url: string | null;
  checkout_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionResourceRecord {
  id: string;
  type: "file" | "github_repository";
  file_id?: string;
  mount_path?: string;
  url?: string;
  checkout?: { type: string; name: string };
  session_id: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Hydrate
// ---------------------------------------------------------------------------

function hydrate(row: SessionResourceRow): SessionResourceRecord {
  const record: SessionResourceRecord = {
    id: row.id,
    type: row.type as "file" | "github_repository",
    session_id: row.session_id,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
  if (row.file_id) record.file_id = row.file_id;
  if (row.mount_path) record.mount_path = row.mount_path;
  if (row.url) record.url = row.url;
  if (row.checkout_json) {
    try {
      record.checkout = JSON.parse(row.checkout_json) as { type: string; name: string };
    } catch { /* ignore malformed JSON */ }
  }
  return record;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createResource(
  sessionId: string,
  input: {
    type: "file" | "github_repository" | "uri" | "text";
    file_id?: string;
    mount_path?: string;
    url?: string;
    repository_url?: string;
    checkout?: { type: string; name: string };
    branch?: string;
    commit?: string;
    uri?: string;
    content?: string;
  },
): SessionResourceRecord {
  const db = getDrizzle();
  const id = newId("sesrsc");
  const now = nowMs();

  // Build checkout JSON for github_repository resources
  let checkoutJson: string | null = null;
  if (input.checkout) {
    checkoutJson = JSON.stringify(input.checkout);
  } else if (input.branch) {
    checkoutJson = JSON.stringify({ type: "branch", name: input.branch });
  } else if (input.commit) {
    checkoutJson = JSON.stringify({ type: "commit", name: input.commit });
  }

  // Determine URL: explicit url, repository_url, or uri
  const url = input.url ?? input.repository_url ?? input.uri ?? null;

  db.insert(schema.sessionResources).values({
    id,
    session_id: sessionId,
    type: input.type,
    file_id: input.file_id ?? null,
    mount_path: input.mount_path ?? null,
    url,
    checkout_json: checkoutJson,
    created_at: now,
    updated_at: now,
  }).run();

  return hydrate({
    id,
    session_id: sessionId,
    type: input.type,
    file_id: input.file_id ?? null,
    mount_path: input.mount_path ?? null,
    url,
    checkout_json: checkoutJson,
    created_at: now,
    updated_at: now,
  });
}

export function listResources(
  sessionId: string,
  opts?: { limit?: number; after_id?: string; before_id?: string },
): SessionResourceRecord[] {
  const db = getDrizzle();
  const limit = opts?.limit ?? 100;

  const conditions = [eq(schema.sessionResources.session_id, sessionId)];
  if (opts?.after_id) conditions.push(gt(schema.sessionResources.id, opts.after_id));
  if (opts?.before_id) conditions.push(lt(schema.sessionResources.id, opts.before_id));

  const rows = db
    .select()
    .from(schema.sessionResources)
    .where(and(...conditions))
    .orderBy(desc(schema.sessionResources.id))
    .limit(limit)
    .all() as SessionResourceRow[];

  return rows.map(hydrate);
}

export function getResource(sessionId: string, resourceId: string): SessionResourceRecord | null {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.sessionResources)
    .where(
      and(
        eq(schema.sessionResources.session_id, sessionId),
        eq(schema.sessionResources.id, resourceId),
      ),
    )
    .get() as SessionResourceRow | undefined;
  return row ? hydrate(row) : null;
}

export function deleteResource(sessionId: string, resourceId: string): { id: string; type: string } | null {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.sessionResources)
    .where(
      and(
        eq(schema.sessionResources.session_id, sessionId),
        eq(schema.sessionResources.id, resourceId),
      ),
    )
    .get() as SessionResourceRow | undefined;
  if (!row) return null;

  db.delete(schema.sessionResources)
    .where(eq(schema.sessionResources.id, resourceId))
    .run();

  return { id: resourceId, type: "session_resource_deleted" };
}

export function countResources(sessionId: string): number {
  const db = getDrizzle();
  const result = db.all(
    sql`SELECT COUNT(*) as cnt FROM session_resources WHERE session_id = ${sessionId}`,
  ) as Array<{ cnt: number }>;
  return result[0]?.cnt ?? 0;
}
