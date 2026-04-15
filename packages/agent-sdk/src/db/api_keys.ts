import crypto from "node:crypto";
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs } from "../util/clock";

export interface ApiKeyRow {
  id: string;
  name: string;
  hash: string;
  prefix: string;
  permissions_json: string;
  created_at: number;
  revoked_at: number | null;
}

function hashKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Create a new API key. Returns the full raw key string ONCE —
 * it is not stored in plain text and cannot be retrieved later.
 */
export function createApiKey(input: {
  name: string;
  permissions?: string[];
  rawKey?: string;
}): { key: string; id: string } {
  const db = getDb();
  const id = newId("key");
  const raw = input.rawKey || `ck_${crypto.randomBytes(24).toString("base64url")}`;
  const hash = hashKey(raw);
  const prefix = raw.slice(0, 8);

  db.prepare(
    `INSERT INTO api_keys (id, name, hash, prefix, permissions_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    hash,
    prefix,
    JSON.stringify(input.permissions ?? ["*"]),
    nowMs(),
  );

  return { key: raw, id };
}

export function findByRawKey(raw: string): ApiKeyRow | null {
  const db = getDb();
  const hash = hashKey(raw);
  return (
    (db
      .prepare(
        `SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL`,
      )
      .get(hash) as ApiKeyRow | undefined) ?? null
  );
}

export function revokeApiKey(id: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(nowMs(), id);
  return res.changes > 0;
}

export function listApiKeys(): Array<Omit<ApiKeyRow, "hash">> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC`,
    )
    .all() as ApiKeyRow[];
  return rows.map(({ hash: _hash, ...rest }) => rest);
}
