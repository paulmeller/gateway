/**
 * File metadata CRUD.
 *
 * Files are stored on disk (see files/storage.ts), metadata in SQLite.
 */
import { eq, and, desc, isNull, sql, gt, lt } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";

export interface FileRow {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  storage_path: string;
  scope_type: string | null;
  scope_id: string | null;
  container_path: string | null;
  content_hash: string | null;
  created_at: number;
}

export interface FileScope {
  type: "session";
  id: string;
}

export interface FileRecord {
  id: string;
  type: "file";
  filename: string;
  mime_type: string;
  size_bytes: number;
  downloadable: boolean;
  scope: FileScope | null;
  created_at: string;
}

function hydrate(row: FileRow): FileRecord {
  return {
    id: row.id,
    type: "file",
    filename: row.filename,
    mime_type: row.content_type,
    size_bytes: row.size,
    downloadable: true, // local files are always downloadable; remote: files are proxy-downloadable
    scope: row.scope_type && row.scope_id ? { type: row.scope_type as "session", id: row.scope_id } : null,
    created_at: toIso(row.created_at),
  };
}

export function createFile(input: {
  filename: string;
  size: number;
  content_type: string;
  storage_path: string;
  scope?: FileScope;
  container_path?: string;
  content_hash?: string;
}): FileRecord {
  const db = getDrizzle();
  const id = newId("file");
  const now = nowMs();
  db.insert(schema.files)
    .values({
      id,
      filename: input.filename,
      size: input.size,
      content_type: input.content_type,
      storage_path: input.storage_path,
      scope_type: input.scope?.type ?? null,
      scope_id: input.scope?.id ?? null,
      container_path: input.container_path ?? null,
      content_hash: input.content_hash ?? null,
      created_at: now,
    })
    .run();
  return {
    id, type: "file" as const, filename: input.filename, mime_type: input.content_type,
    size_bytes: input.size, downloadable: true,
    scope: input.scope ?? null, created_at: toIso(now),
  };
}

export function findFileByContainerPath(scopeId: string, containerPath: string, contentHash: string): FileRow | null {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.files)
    .where(
      and(
        eq(schema.files.scope_id, scopeId),
        eq(schema.files.container_path, containerPath),
        eq(schema.files.content_hash, contentHash),
      ),
    )
    .get();
  return (row as FileRow | undefined) ?? null;
}

export function getFile(id: string): FileRow | null {
  const db = getDrizzle();
  const row = db.select().from(schema.files).where(eq(schema.files.id, id)).get();
  return (row as FileRow | undefined) ?? null;
}

export function getFileRecord(id: string): FileRecord | null {
  const row = getFile(id);
  return row ? hydrate(row) : null;
}

export interface FileListResult {
  data: FileRecord[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

export function listFiles(opts?: { limit?: number; scope_id?: string; before_id?: string; after_id?: string }): FileListResult {
  const db = getDrizzle();
  const limit = opts?.limit ?? 100;
  // Deduplicate container-synced files: for files with the same container_path
  // in the same scope, only return the latest version (highest created_at).
  // Files without container_path (uploaded files) are always included.

  // Build cursor clause for ULID-based pagination (lexicographic ordering)
  const cursorClause = opts?.after_id
    ? sql` AND f.id > ${opts.after_id}`
    : opts?.before_id
      ? sql` AND f.id < ${opts.before_id}`
      : sql``;

  if (opts?.scope_id) {
    const rows = db.all(
      sql`SELECT f.* FROM files f
        LEFT JOIN files f2
          ON f.scope_id = f2.scope_id
          AND f.container_path = f2.container_path
          AND f.container_path IS NOT NULL
          AND (f2.created_at > f.created_at OR (f2.created_at = f.created_at AND f2.id > f.id))
        WHERE f.scope_id = ${opts.scope_id} AND f2.id IS NULL${cursorClause}
        ORDER BY f.id DESC LIMIT ${limit + 1}`,
    ) as FileRow[];
    const has_more = rows.length > limit;
    if (has_more) rows.pop();
    const records = rows.map(hydrate);
    return {
      data: records,
      has_more,
      first_id: records.length > 0 ? records[0].id : null,
      last_id: records.length > 0 ? records[records.length - 1].id : null,
    };
  }

  // Unscoped listing (global admin)
  let cursorCondition;
  if (opts?.after_id) {
    cursorCondition = gt(schema.files.id, opts.after_id);
  } else if (opts?.before_id) {
    cursorCondition = lt(schema.files.id, opts.before_id);
  }
  const query = cursorCondition
    ? db.select().from(schema.files).where(cursorCondition).orderBy(desc(schema.files.id)).limit(limit + 1)
    : db.select().from(schema.files).orderBy(desc(schema.files.id)).limit(limit + 1);
  const rows = query.all() as FileRow[];
  const has_more = rows.length > limit;
  if (has_more) rows.pop();
  const records = rows.map(hydrate);
  return {
    data: records,
    has_more,
    first_id: records.length > 0 ? records[0].id : null,
    last_id: records.length > 0 ? records[records.length - 1].id : null,
  };
}

export function countFilesForScope(scopeId: string): number {
  const db = getDrizzle();
  const result = db.all(
    sql`SELECT COUNT(*) as cnt FROM files WHERE scope_id = ${scopeId}`,
  ) as Array<{ cnt: number }>;
  return result[0]?.cnt ?? 0;
}

export function updateFileStoragePath(id: string, storagePath: string): void {
  const db = getDrizzle();
  db.update(schema.files)
    .set({ storage_path: storagePath })
    .where(eq(schema.files.id, id))
    .run();
}

export function deleteFileRecord(id: string): { id: string; type: string } | null {
  const db = getDrizzle();
  const row = getFile(id);
  if (!row) return null;
  db.delete(schema.files).where(eq(schema.files.id, id)).run();
  return { id, type: "file_deleted" };
}
