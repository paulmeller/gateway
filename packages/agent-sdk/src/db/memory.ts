import { createHash } from "node:crypto";
import { eq, and, asc, desc, like, or, sql } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { MemoryStore, MemoryStoreRow, Memory, MemoryRow } from "../types";

function hydrateStore(row: MemoryStoreRow): MemoryStore {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    agent_id: row.agent_id,
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

export function createMemoryStore(input: {
  name: string;
  description?: string | null;
  agent_id?: string | null;
}): MemoryStore {
  const db = getDrizzle();
  const id = newId("memstore");
  const now = nowMs();
  db.insert(schema.memoryStores)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      agent_id: input.agent_id ?? null,
      created_at: now,
      updated_at: now,
    })
    .run();
  return getMemoryStore(id)!;
}

export function getMemoryStore(id: string): MemoryStore | null {
  const db = getDrizzle();
  const row = db.select().from(schema.memoryStores).where(eq(schema.memoryStores.id, id)).get();
  return row ? hydrateStore(row as MemoryStoreRow) : null;
}

export function listMemoryStores(opts: {
  agent_id?: string;
  /** v0.5 tenancy: filter by agent's tenant. Requires a JOIN. */
  tenantFilter?: string | null;
} = {}): MemoryStore[] {
  const db = getDrizzle();

  // When tenantFilter is set, we need a JOIN through agents to check tenant.
  // Stores without an agent (legacy null agent_id) are excluded from
  // tenant-filtered queries.
  if (opts.tenantFilter != null) {
    if (opts.agent_id) {
      const rows = db.all(
        sql`SELECT ms.* FROM memory_stores ms LEFT JOIN agents a ON a.id = ms.agent_id WHERE ms.agent_id = ${opts.agent_id} AND a.tenant_id = ${opts.tenantFilter} ORDER BY ms.created_at DESC`,
      ) as MemoryStoreRow[];
      return rows.map(hydrateStore);
    }
    const rows = db.all(
      sql`SELECT ms.* FROM memory_stores ms LEFT JOIN agents a ON a.id = ms.agent_id WHERE a.tenant_id = ${opts.tenantFilter} ORDER BY ms.created_at DESC`,
    ) as MemoryStoreRow[];
    return rows.map(hydrateStore);
  }

  // Simple case: no tenant filter
  if (opts.agent_id) {
    const rows = db.select().from(schema.memoryStores)
      .where(eq(schema.memoryStores.agent_id, opts.agent_id))
      .orderBy(desc(schema.memoryStores.created_at))
      .all();
    return (rows as MemoryStoreRow[]).map(hydrateStore);
  }

  const rows = db.select().from(schema.memoryStores).orderBy(desc(schema.memoryStores.created_at)).all();
  return (rows as MemoryStoreRow[]).map(hydrateStore);
}

export function deleteMemoryStore(id: string): boolean {
  const db = getDrizzle();
  const res = db.delete(schema.memoryStores).where(eq(schema.memoryStores.id, id)).run();
  return res.changes > 0;
}

// ── Memories ─────────────────────────────────────────────────────────────

export function createOrUpsertMemory(storeId: string, path: string, content: string): Memory {
  const db = getDrizzle();
  const hash = sha256(content);
  const now = nowMs();
  const id = newId("mem");

  db.insert(schema.memories)
    .values({
      id,
      store_id: storeId,
      path,
      content,
      content_sha256: hash,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [schema.memories.store_id, schema.memories.path],
      set: {
        content,
        content_sha256: hash,
        updated_at: now,
      },
    })
    .run();

  return getMemoryByPath(storeId, path)!;
}

export function getMemory(id: string): Memory | null {
  const db = getDrizzle();
  const row = db.select().from(schema.memories).where(eq(schema.memories.id, id)).get();
  return row ? hydrateMemory(row as MemoryRow) : null;
}

export function getMemoryByPath(storeId: string, path: string): Memory | null {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.memories)
    .where(and(eq(schema.memories.store_id, storeId), eq(schema.memories.path, path)))
    .get();
  return row ? hydrateMemory(row as MemoryRow) : null;
}

export function listMemories(storeId: string): Memory[] {
  const db = getDrizzle();
  const rows = db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.store_id, storeId))
    .orderBy(asc(schema.memories.path))
    .all();
  return (rows as MemoryRow[]).map(hydrateMemory);
}

export function searchMemories(storeId: string, query: string): Memory[] {
  const db = getDrizzle();
  const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const pattern = `%${escaped}%`;
  const rows = db
    .select()
    .from(schema.memories)
    .where(
      and(
        eq(schema.memories.store_id, storeId),
        or(
          like(schema.memories.path, pattern),
          like(schema.memories.content, pattern),
        ),
      ),
    )
    .orderBy(asc(schema.memories.path))
    .all();
  return (rows as MemoryRow[]).map(hydrateMemory);
}

export function updateMemory(
  id: string,
  content: string,
  preconditionSha256?: string,
): { memory: Memory | null; conflict: boolean } {
  const db = getDrizzle();
  const existing = getMemory(id);
  if (!existing) return { memory: null, conflict: false };

  if (preconditionSha256 && existing.content_sha256 !== preconditionSha256) {
    return { memory: null, conflict: true };
  }

  const hash = sha256(content);
  const now = nowMs();
  db.update(schema.memories)
    .set({ content, content_sha256: hash, updated_at: now })
    .where(eq(schema.memories.id, id))
    .run();
  return { memory: getMemory(id), conflict: false };
}

export function deleteMemory(id: string): boolean {
  const db = getDrizzle();
  const res = db.delete(schema.memories).where(eq(schema.memories.id, id)).run();
  return res.changes > 0;
}
