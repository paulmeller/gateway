/**
 * Upstream-key pool storage (v0.4 PR4).
 *
 * Per-provider pool with LRU selection. Values encrypted at rest via
 * vault-crypto.ts — same AES-256-GCM key that protects vault entries.
 * `hash` column is SHA-256 of the raw value, `UNIQUE`, used for dedup
 * only (so adding the same key twice is idempotent). Retrieval is by
 * pool identity, not by hash.
 *
 * Failure tracking:
 *   - In-memory consecutive-failure counter lives in the caller
 *     (providers/upstream-keys.ts). On N consecutive failures the caller
 *     marks the key disabled here via `disableUpstreamKey`.
 *   - `disabled_at` is persistent so a restart doesn't re-try the bad key
 *     — admin must explicitly re-enable it.
 */
import crypto from "node:crypto";
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs } from "../util/clock";
import { encryptValue, decryptValue } from "./vault-crypto";

export interface UpstreamKeyRow {
  id: string;
  provider: string;
  hash: string;
  prefix: string;
  value_encrypted: string;
  weight: number;
  disabled_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

/** Safe-to-expose view — never includes the raw value. */
export interface UpstreamKeyView {
  id: string;
  provider: string;
  prefix: string;
  weight: number;
  disabled_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

function hashValue(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function toView(r: UpstreamKeyRow): UpstreamKeyView {
  return {
    id: r.id,
    provider: r.provider,
    prefix: r.prefix,
    weight: r.weight,
    disabled_at: r.disabled_at,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
  };
}

/**
 * Add a key to the pool. Value is encrypted before storage. Returns the
 * created row's view. Duplicate insertion (same raw value for the same
 * provider) throws — the hash UNIQUE constraint trips.
 */
export function addUpstreamKey(input: {
  provider: string;
  value: string;
  weight?: number;
}): UpstreamKeyView {
  const db = getDb();
  const id = newId("ukey");
  const hash = hashValue(input.value);
  const prefix = input.value.slice(0, 10);
  const encrypted = encryptValue(input.value);
  const now = nowMs();
  db.prepare(
    `INSERT INTO upstream_keys (id, provider, hash, prefix, value_encrypted, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.provider, hash, prefix, encrypted, input.weight ?? 1, now);
  return toView({
    id,
    provider: input.provider,
    hash,
    prefix,
    value_encrypted: encrypted,
    weight: input.weight ?? 1,
    disabled_at: null,
    last_used_at: null,
    created_at: now,
  });
}

export function listUpstreamKeys(provider?: string): UpstreamKeyView[] {
  const db = getDb();
  const rows = provider
    ? (db
        .prepare(`SELECT * FROM upstream_keys WHERE provider = ? ORDER BY created_at DESC`)
        .all(provider) as UpstreamKeyRow[])
    : (db
        .prepare(`SELECT * FROM upstream_keys ORDER BY created_at DESC`)
        .all() as UpstreamKeyRow[]);
  return rows.map(toView);
}

/**
 * Select the least-recently-used active key for a provider. Mutates
 * last_used_at to now so the next call picks a different key (round-robin).
 * Returns the DECRYPTED raw value plus the row id so callers can report
 * failures back via `disableUpstreamKey`.
 */
export function selectNextUpstreamKey(provider: string): { id: string; value: string } | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM upstream_keys
         WHERE provider = ? AND disabled_at IS NULL
         ORDER BY last_used_at ASC NULLS FIRST, created_at ASC
         LIMIT 1`,
    )
    .get(provider) as UpstreamKeyRow | undefined;
  if (!row) return null;
  // Touch last_used_at so a subsequent selection picks someone else.
  db.prepare(`UPDATE upstream_keys SET last_used_at = ? WHERE id = ?`).run(nowMs(), row.id);
  try {
    return { id: row.id, value: decryptValue(row.value_encrypted) };
  } catch (err) {
    // Corrupt ciphertext — disable the row so we don't keep hitting
    // it. The usual cause is a rotated / changed VAULT_ENCRYPTION_KEY
    // without re-encrypting existing rows: once the key changes, every
    // pool row becomes "corrupt" simultaneously and the gateway
    // appears to fail with "no upstream key available." Call that out
    // loudly so the operator can correlate.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[upstream-keys] DISABLING ${row.id} (provider=${row.provider}, prefix=${row.prefix}) ` +
      `— decryption failed (${msg}). ` +
      `Most likely VAULT_ENCRYPTION_KEY changed since this row was written. ` +
      `Check your .env / secrets, restore the prior VAULT_ENCRYPTION_KEY, or re-add pool keys with the new key.`,
    );
    disableUpstreamKey(row.id);
    return null;
  }
}

export function disableUpstreamKey(id: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE upstream_keys SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`)
    .run(nowMs(), id);
  return res.changes > 0;
}

export function enableUpstreamKey(id: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE upstream_keys SET disabled_at = NULL WHERE id = ?`)
    .run(id);
  return res.changes > 0;
}

export function deleteUpstreamKey(id: string): boolean {
  const db = getDb();
  const res = db.prepare(`DELETE FROM upstream_keys WHERE id = ?`).run(id);
  return res.changes > 0;
}

export function getUpstreamKey(id: string): UpstreamKeyView | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM upstream_keys WHERE id = ?`)
    .get(id) as UpstreamKeyRow | undefined;
  return row ? toView(row) : null;
}
