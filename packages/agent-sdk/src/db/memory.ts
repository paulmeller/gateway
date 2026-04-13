import { createHash } from "node:crypto";
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { MemoryStore, MemoryStoreRow, Memory, MemoryRow } from "../types";

function hydrateStore(row: MemoryStoreRow): MemoryStore {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function hydrateMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    store_id: row.store_id,
    path: row.path,
    content: row.content,
    content_sha256: row.content_sha256,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Memory Stores ────────────────────────────────────────────────────────

export function createMemoryStore(input: { name: string; description?: string | null }): MemoryStore {
  const db = getDb();
  const id = newId("ms");
  const now = nowMs();
  db.prepare(
    `INSERT INTO memory_stores (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.name, input.description ?? null, now, now);
  return getMemoryStore(id)!;
}

export function getMemoryStore(id: string): MemoryStore | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM memory_stores WHERE id = ?`).get(id) as MemoryStoreRow | undefined;
  return row ? hydrateStore(row) : null;
}

export function listMemoryStores(): MemoryStore[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM memory_stores ORDER BY created_at DESC`).all() as MemoryStoreRow[];
  return rows.map(hydrateStore);
}

export function deleteMemoryStore(id: string): boolean {
  const db = getDb();
  const res = db.prepare(`DELETE FROM memory_stores WHERE id = ?`).run(id);
  return res.changes > 0;
}

// ── Memories ─────────────────────────────────────────────────────────────

export function createOrUpsertMemory(storeId: string, path: string, content: string): Memory {
  const db = getDb();
  const hash = sha256(content);
  const now = nowMs();
  const id = newId("mem");

  db.prepare(
    `INSERT INTO memories (id, store_id, path, content, content_sha256, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(store_id, path) DO UPDATE SET content = excluded.content, content_sha256 = excluded.content_sha256, updated_at = excluded.updated_at`,
  ).run(id, storeId, path, content, hash, now, now);

  return getMemoryByPath(storeId, path)!;
}

export function getMemory(id: string): Memory | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
  return row ? hydrateMemory(row) : null;
}

export function getMemoryByPath(storeId: string, path: string): Memory | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM memories WHERE store_id = ? AND path = ?`,
    )
    .get(storeId, path) as MemoryRow | undefined;
  return row ? hydrateMemory(row) : null;
}

export function listMemories(storeId: string): Memory[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE store_id = ? ORDER BY path ASC`,
    )
    .all(storeId) as MemoryRow[];
  return rows.map(hydrateMemory);
}

export function searchMemories(storeId: string, query: string): Memory[] {
  const db = getDb();
  const escaped = query.replace(/%/g, '\\%').replace(/_/g, '\\_');
  const pattern = `%${escaped}%`;
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE store_id = ? AND (path LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY path ASC`,
    )
    .all(storeId, pattern, pattern) as MemoryRow[];
  return rows.map(hydrateMemory);
}

export function updateMemory(
  id: string,
  content: string,
  preconditionSha256?: string,
): { memory: Memory | null; conflict: boolean } {
  const db = getDb();
  const existing = getMemory(id);
  if (!existing) return { memory: null, conflict: false };

  if (preconditionSha256 && existing.content_sha256 !== preconditionSha256) {
    return { memory: null, conflict: true };
  }

  const hash = sha256(content);
  const now = nowMs();
  db.prepare(
    `UPDATE memories SET content = ?, content_sha256 = ?, updated_at = ? WHERE id = ?`,
  ).run(content, hash, now, id);
  return { memory: getMemory(id), conflict: false };
}

export function deleteMemory(id: string): boolean {
  const db = getDb();
  const res = db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  return res.changes > 0;
}
