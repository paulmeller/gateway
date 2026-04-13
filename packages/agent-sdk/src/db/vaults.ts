/**
 * Vault persistence: SQLite-backed key-value stores scoped to agents.
 *
 * Data persists across sessions. When `vault_ids` is set on a session,
 * the driver provisions vault data into the container at turn start.
 */
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { Vault, VaultEntry, VaultEntryRow, VaultRow } from "../types";

function hydrateVault(row: VaultRow): Vault {
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function createVault(input: {
  agent_id: string;
  name: string;
}): Vault {
  const db = getDb();
  const id = newId("vault");
  const now = nowMs();

  db.prepare(
    `INSERT INTO vaults (id, agent_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.agent_id, input.name, now, now);

  return getVault(id)!;
}

export function getVault(id: string): Vault | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM vaults WHERE id = ?`)
    .get(id) as VaultRow | undefined;
  return row ? hydrateVault(row) : null;
}

export function listVaults(opts: { agent_id?: string }): Vault[] {
  const db = getDb();
  if (opts.agent_id) {
    const rows = db
      .prepare(
        `SELECT * FROM vaults WHERE agent_id = ? ORDER BY created_at DESC`,
      )
      .all(opts.agent_id) as VaultRow[];
    return rows.map(hydrateVault);
  }
  const rows = db
    .prepare(`SELECT * FROM vaults ORDER BY created_at DESC`)
    .all() as VaultRow[];
  return rows.map(hydrateVault);
}

export function deleteVault(id: string): boolean {
  const db = getDb();
  const res = db.prepare(`DELETE FROM vaults WHERE id = ?`).run(id);
  return res.changes > 0;
}

export function setEntry(vaultId: string, key: string, value: string): void {
  const db = getDb();
  const now = nowMs();
  db.prepare(
    `INSERT INTO vault_entries (vault_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(vault_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(vaultId, key, value, now);

  // Update vault's updated_at timestamp
  db.prepare(`UPDATE vaults SET updated_at = ? WHERE id = ?`).run(now, vaultId);
}

export function getEntry(
  vaultId: string,
  key: string,
): VaultEntry | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM vault_entries WHERE vault_id = ? AND key = ?`,
    )
    .get(vaultId, key) as VaultEntryRow | undefined;
  return row ? { key: row.key, value: row.value } : null;
}

export function listEntries(vaultId: string): VaultEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM vault_entries WHERE vault_id = ? ORDER BY key ASC`,
    )
    .all(vaultId) as VaultEntryRow[];
  return rows.map((r) => ({ key: r.key, value: r.value }));
}

export function deleteEntry(vaultId: string, key: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`DELETE FROM vault_entries WHERE vault_id = ? AND key = ?`)
    .run(vaultId, key);
  return res.changes > 0;
}
