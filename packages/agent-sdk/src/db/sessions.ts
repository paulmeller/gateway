import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { Session, SessionResource, SessionRow, SessionStatus } from "../types";

export function hydrateSession(row: SessionRow): Session {
  return {
    id: row.id,
    agent: { id: row.agent_id, version: row.agent_version },
    environment_id: row.environment_id,
    status: row.status,
    stop_reason: row.stop_reason,
    title: row.title,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    max_budget_usd: row.max_budget_usd ?? null,
    outcome: row.outcome_criteria_json ? (JSON.parse(row.outcome_criteria_json) as Record<string, unknown>) : null,
    resources: row.resources_json ? (JSON.parse(row.resources_json) as SessionResource[]) : null,
    vault_ids: row.vault_ids_json ? (JSON.parse(row.vault_ids_json) as string[]) : null,
    parent_session_id: row.parent_session_id ?? null,
    thread_depth: row.thread_depth ?? 0,
    stats: {
      turn_count: row.turn_count,
      tool_calls_count: row.tool_calls_count,
      active_seconds: row.active_seconds,
      duration_seconds: row.duration_seconds,
    },
    usage: {
      input_tokens: row.usage_input_tokens,
      output_tokens: row.usage_output_tokens,
      cache_read_input_tokens: row.usage_cache_read_input_tokens,
      cache_creation_input_tokens: row.usage_cache_creation_input_tokens,
      cost_usd: row.usage_cost_usd,
    },
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    archived_at: row.archived_at ? toIso(row.archived_at) : null,
  };
}

export function createSession(input: {
  agent_id: string;
  agent_version: number;
  environment_id: string;
  title?: string | null;
  metadata?: Record<string, unknown>;
  max_budget_usd?: number | null;
  resources?: SessionResource[] | null;
  vault_ids?: string[] | null;
  parent_session_id?: string | null;
  thread_depth?: number;
}): Session {
  const db = getDb();
  const id = newId("sess");
  const now = nowMs();

  db.prepare(
    `INSERT INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, max_budget_usd, resources_json,
       vault_ids_json, parent_session_id, thread_depth,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.agent_id,
    input.agent_version,
    input.environment_id,
    input.title ?? null,
    JSON.stringify(input.metadata ?? {}),
    input.max_budget_usd ?? null,
    input.resources ? JSON.stringify(input.resources) : null,
    input.vault_ids ? JSON.stringify(input.vault_ids) : null,
    input.parent_session_id ?? null,
    input.thread_depth ?? 0,
    now,
    now,
  );

  return getSession(id)!;
}

export function getSession(id: string): Session | null {
  const row = getSessionRow(id);
  return row ? hydrateSession(row) : null;
}

export function getSessionRow(id: string): SessionRow | null {
  const db = getDb();
  return (
    (db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined) ?? null
  );
}

export function updateSessionStatus(
  id: string,
  status: SessionStatus,
  stopReason?: string | null,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE sessions SET status = ?, stop_reason = ?, updated_at = ? WHERE id = ?`,
  ).run(status, stopReason ?? null, nowMs(), id);
}

export function setSessionSprite(id: string, spriteName: string | null): void {
  const db = getDb();
  db.prepare(
    `UPDATE sessions SET sprite_name = ?, updated_at = ? WHERE id = ?`,
  ).run(spriteName, nowMs(), id);
}

/**
 * Store the backend's session id for subsequent resume turns. The DB column
 * is named `claude_session_id` for historical reasons but holds any
 * backend's session id (claude's `session_id`, opencode's `sessionID`).
 */
export function setBackendSessionId(id: string, backendSessionId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?`,
  ).run(backendSessionId, nowMs(), id);
}

export function setSessionProvider(id: string, providerName: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE sessions SET provider_name = ?, updated_at = ? WHERE id = ?`,
  ).run(providerName, nowMs(), id);
}

export function setIdleSince(id: string, idleSince: number | null): void {
  const db = getDb();
  db.prepare(`UPDATE sessions SET idle_since = ? WHERE id = ?`).run(idleSince, id);
}

export function updateSessionMutable(
  id: string,
  input: { title?: string | null; metadata?: Record<string, unknown> },
): Session | null {
  const db = getDb();
  const existing = getSession(id);
  if (!existing) return null;

  db.prepare(
    `UPDATE sessions SET title = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
  ).run(
    input.title ?? existing.title,
    JSON.stringify(input.metadata ?? existing.metadata),
    nowMs(),
    id,
  );

  return getSession(id);
}

export interface UsageDelta {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

export function bumpSessionStats(
  id: string,
  delta: { turn_count?: number; tool_calls_count?: number; duration_seconds?: number; active_seconds?: number },
  usage?: UsageDelta,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE sessions SET
       turn_count                        = turn_count + ?,
       tool_calls_count                  = tool_calls_count + ?,
       active_seconds                    = active_seconds + ?,
       duration_seconds                  = duration_seconds + ?,
       usage_input_tokens                = usage_input_tokens + ?,
       usage_output_tokens               = usage_output_tokens + ?,
       usage_cache_read_input_tokens     = usage_cache_read_input_tokens + ?,
       usage_cache_creation_input_tokens = usage_cache_creation_input_tokens + ?,
       usage_cost_usd                    = usage_cost_usd + ?,
       updated_at                        = ?
     WHERE id = ?`,
  ).run(
    delta.turn_count ?? 0,
    delta.tool_calls_count ?? 0,
    delta.active_seconds ?? 0,
    delta.duration_seconds ?? 0,
    usage?.input_tokens ?? 0,
    usage?.output_tokens ?? 0,
    usage?.cache_read_input_tokens ?? 0,
    usage?.cache_creation_input_tokens ?? 0,
    usage?.cost_usd ?? 0,
    nowMs(),
    id,
  );
}

export function archiveSession(id: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL`)
    .run(nowMs(), nowMs(), id);
  return res.changes > 0;
}

export function listSessions(opts: {
  agent_id?: string;
  agent_version?: number;
  environmentId?: string;
  parent_session_id?: string;
  status?: SessionStatus;
  limit?: number;
  order?: "asc" | "desc";
  includeArchived?: boolean;
  cursor?: string;
  createdGt?: number;
  createdGte?: number;
  createdLt?: number;
  createdLte?: number;
}): Session[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const order = opts.order === "asc" ? "ASC" : "DESC";
  const includeArchived = opts.includeArchived ?? false;

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.agent_id) {
    clauses.push("agent_id = ?");
    params.push(opts.agent_id);
  }
  if (opts.agent_version != null) {
    clauses.push("agent_version = ?");
    params.push(opts.agent_version);
  }
  if (opts.environmentId) {
    clauses.push("environment_id = ?");
    params.push(opts.environmentId);
  }
  if (opts.parent_session_id) {
    clauses.push("parent_session_id = ?");
    params.push(opts.parent_session_id);
  }
  if (opts.status) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (!includeArchived) clauses.push("archived_at IS NULL");
  if (opts.createdGt != null) {
    clauses.push("created_at > ?");
    params.push(opts.createdGt);
  }
  if (opts.createdGte != null) {
    clauses.push("created_at >= ?");
    params.push(opts.createdGte);
  }
  if (opts.createdLt != null) {
    clauses.push("created_at < ?");
    params.push(opts.createdLt);
  }
  if (opts.createdLte != null) {
    clauses.push("created_at <= ?");
    params.push(opts.createdLte);
  }
  if (opts.cursor) {
    clauses.push(order === "DESC" ? "id < ?" : "id > ?");
    params.push(opts.cursor);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM sessions ${where} ORDER BY id ${order} LIMIT ?`,
    )
    .all(...params, limit) as SessionRow[];

  return rows.map(hydrateSession);
}

export function setOutcomeCriteria(id: string, criteria: Record<string, unknown>): void {
  const db = getDb();
  db.prepare(`UPDATE sessions SET outcome_criteria_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(criteria),
    nowMs(),
    id,
  );
}

export function getOutcomeCriteria(id: string): Record<string, unknown> | null {
  const row = getSessionRow(id);
  return row?.outcome_criteria_json ? (JSON.parse(row.outcome_criteria_json) as Record<string, unknown>) : null;
}
