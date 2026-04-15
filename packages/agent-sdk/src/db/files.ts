/**
 * File metadata CRUD.
 *
 * Files are stored on disk (see files/storage.ts), metadata in SQLite.
 */
import { getDb } from "./client";
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
  created_at: number;
}

export interface FileScope {
  type: "session";
  id: string;
}

export interface FileRecord {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  scope: FileScope | null;
  created_at: string;
}

function hydrate(row: FileRow): FileRecord {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size,
    content_type: row.content_type,
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
}): FileRecord {
  const db = getDb();
  const id = newId("file");
  const now = nowMs();
  db.prepare(
    `INSERT INTO files (id, filename, size, content_type, storage_path, scope_type, scope_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.filename, input.size, input.content_type, input.storage_path, input.scope?.type ?? null, input.scope?.id ?? null, now);
  return {
    id, filename: input.filename, size: input.size, content_type: input.content_type,
    scope: input.scope ?? null, created_at: toIso(now),
  };
}

export function getFile(id: string): FileRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as FileRow | undefined;
  return row ?? null;
}

export function getFileRecord(id: string): FileRecord | null {
  const row = getFile(id);
  return row ? hydrate(row) : null;
}

export function listFiles(opts?: { limit?: number; scope_id?: string }): FileRecord[] {
  const db = getDb();
  const limit = opts?.limit ?? 100;
  if (opts?.scope_id) {
    const rows = db.prepare(`SELECT * FROM files WHERE scope_id = ? ORDER BY created_at DESC LIMIT ?`).all(opts.scope_id, limit) as FileRow[];
    return rows.map(hydrate);
  }
  const rows = db.prepare(`SELECT * FROM files ORDER BY created_at DESC LIMIT ?`).all(limit) as FileRow[];
  return rows.map(hydrate);
}

export function deleteFileRecord(id: string): { id: string; type: string } | null {
  const db = getDb();
  const row = getFile(id);
  if (!row) return null;
  db.prepare(`DELETE FROM files WHERE id = ?`).run(id);
  return { id, type: "file_deleted" };
}
