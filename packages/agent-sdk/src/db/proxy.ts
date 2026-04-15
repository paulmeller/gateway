/**
 * Proxy routing table: tracks which resource IDs belong to Anthropic's
 * hosted Managed Agents API. The route handlers check `isProxied(id)`
 * before touching local state — if true, they forward to Anthropic.
 *
 * Anthropic owns the IDs (they're assigned by their API on create). We
 * store them in this table after a successful proxy-create so subsequent
 * requests for that ID auto-route without the client needing to specify
 * anything.
 */
import { getDb } from "./client";
import { nowMs } from "../util/clock";

export type ProxiedResourceType = "agent" | "environment" | "session";

export function isProxied(id: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT resource_id FROM proxy_resources WHERE resource_id = ?`,
    )
    .get(id) as { resource_id: string } | undefined;
  return !!row;
}

export function markProxied(id: string, type: ProxiedResourceType): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO proxy_resources (resource_id, resource_type, created_at)
     VALUES (?, ?, ?)`,
  ).run(id, type, nowMs());
}

export function unmarkProxied(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM proxy_resources WHERE resource_id = ?`).run(id);
}
