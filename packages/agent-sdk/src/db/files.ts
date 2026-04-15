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
  created_at: number;
}

export interface FileRecord {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  created_at: string;
}

function hydrate(row: FileRow): FileRecord {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size,
    content_type: row.content_type,
    created_at: toIso(row.created_at),
  };
}

export function createFile(input: {
  filename: string;
  size: number;
  content_type: string;
  storage_path: string;
}): FileRecord {
  const db = getDb();
  const id = newId("file");
  const now = nowMs();
  db.prepare(
    `INSERT INTO files (id, filename, size, content_type, storage_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.filename, input.size, input.content_type, input.storage_path, now);
  return { id, filename: input.filename, size: input.size, content_type: input.content_type, created_at: toIso(now) };
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

export function listFiles(opts?: { limit?: number }): FileRecord[] {
  const db = getDb();
  const limit = opts?.limit ?? 100;
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
