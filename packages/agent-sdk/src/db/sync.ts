/**
 * Anthropic sync table — maps local resource IDs to remote Anthropic IDs.
 *
 * Used by the sync-and-proxy flow: AgentStep manages config locally,
 * syncs to Anthropic at session start, then proxies execution traffic.
 */
import { getDb } from "./client";
import { nowMs } from "../util/clock";

export type SyncResourceType = "agent" | "environment" | "vault" | "session";

interface SyncRow {
  local_id: string;
  resource_type: SyncResourceType;
  remote_id: string;
  synced_at: number;
  config_hash: string | null;
}

export function getSyncedRemoteId(localId: string, type: SyncResourceType): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT remote_id FROM anthropic_sync WHERE local_id = ? AND resource_type = ?")
    .get(localId, type) as { remote_id: string } | undefined;
  return row?.remote_id ?? null;
}

export function getSyncRow(localId: string, type: SyncResourceType): SyncRow | null {
  const db = getDb();
  return (db
    .prepare("SELECT * FROM anthropic_sync WHERE local_id = ? AND resource_type = ?")
    .get(localId, type) as SyncRow | undefined) ?? null;
}

export function upsertSync(
  localId: string,
  type: SyncResourceType,
  remoteId: string,
  configHash?: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO anthropic_sync (local_id, resource_type, remote_id, synced_at, config_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(local_id, resource_type)
     DO UPDATE SET remote_id = excluded.remote_id, synced_at = excluded.synced_at, config_hash = excluded.config_hash`,
  ).run(localId, type, remoteId, nowMs(), configHash ?? null);
}

export function removeSync(localId: string, type: SyncResourceType): void {
  const db = getDb();
  db.prepare("DELETE FROM anthropic_sync WHERE local_id = ? AND resource_type = ?").run(localId, type);
}

/**
 * Resolve a local session ID to its remote Anthropic session ID.
 * For pure proxy sessions (where Anthropic assigned the ID), the local ID IS the remote ID.
 * For sync-and-proxy sessions, looks up the mapping in anthropic_sync.
 */
export function resolveRemoteSessionId(localSessionId: string): string {
  const remoteId = getSyncedRemoteId(localSessionId, "session");
  return remoteId ?? localSessionId;
}
