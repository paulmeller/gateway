import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { Environment, EnvironmentConfig, EnvironmentRow, EnvironmentState } from "../types";

function hydrate(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    config: JSON.parse(row.config_json) as EnvironmentConfig,
    metadata: (row.metadata_json ? JSON.parse(row.metadata_json) : {}) as Record<string, string>,
    state: row.state,
    state_message: row.state_message,
    created_at: toIso(row.created_at),
    archived_at: row.archived_at ? toIso(row.archived_at) : null,
  };
}

export function createEnvironment(input: {
  name: string;
  config: EnvironmentConfig;
  description?: string | null;
  metadata?: Record<string, string>;
}): Environment {
  const db = getDb();
  const id = newId("env");
  const now = nowMs();

  db.prepare(
    `INSERT INTO environments (id, name, description, config_json, metadata_json, state, created_at)
     VALUES (?, ?, ?, ?, ?, 'preparing', ?)`,
  ).run(
    id,
    input.name,
    input.description ?? null,
    JSON.stringify(input.config),
    JSON.stringify(input.metadata ?? {}),
    now,
  );

  return getEnvironment(id)!;
}

export function updateEnvironment(
  id: string,
  updates: {
    name?: string;
    description?: string | null;
    metadata?: Record<string, string>;
    config?: EnvironmentConfig;
  },
): Environment | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM environments WHERE id = ?`)
    .get(id) as EnvironmentRow | undefined;
  if (!row) return null;

  const newName = updates.name !== undefined ? updates.name : row.name;
  const newDescription =
    updates.description !== undefined ? updates.description : row.description;
  const newConfigJson =
    updates.config !== undefined ? JSON.stringify(updates.config) : row.config_json;
  const newMetadataJson =
    updates.metadata !== undefined
      ? JSON.stringify(updates.metadata)
      : row.metadata_json ?? "{}";

  db.prepare(
    `UPDATE environments SET name = ?, description = ?, config_json = ?, metadata_json = ? WHERE id = ?`,
  ).run(newName, newDescription ?? null, newConfigJson, newMetadataJson, id);

  return getEnvironment(id);
}

export function getEnvironment(id: string): Environment | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM environments WHERE id = ?`)
    .get(id) as EnvironmentRow | undefined;
  return row ? hydrate(row) : null;
}

export function getEnvironmentRow(id: string): EnvironmentRow | null {
  const db = getDb();
  return (
    (db
      .prepare(`SELECT * FROM environments WHERE id = ?`)
      .get(id) as EnvironmentRow | undefined) ?? null
  );
}

export function updateEnvironmentState(
  id: string,
  state: EnvironmentState,
  message?: string | null,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE environments SET state = ?, state_message = ? WHERE id = ?`,
  ).run(state, message ?? null, id);
}

export function updateEnvironmentCheckpoint(
  id: string,
  checkpointId: string,
  templateSprite: string | null,
): void {
  const db = getDb();
  db.prepare(
    `UPDATE environments SET checkpoint_id = ?, template_sprite = ? WHERE id = ?`,
  ).run(checkpointId, templateSprite, id);
}

export function archiveEnvironment(id: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE environments SET archived_at = ? WHERE id = ? AND archived_at IS NULL`)
    .run(nowMs(), id);
  return res.changes > 0;
}

export function deleteEnvironment(id: string): boolean {
  const db = getDb();
  // Archive any sessions referencing this environment to avoid FK constraint
  db.prepare(`UPDATE sessions SET archived_at = ? WHERE environment_id = ? AND archived_at IS NULL`).run(nowMs(), id);
  const res = db.prepare(`DELETE FROM environments WHERE id = ?`).run(id);
  return res.changes > 0;
}

export function listEnvironments(opts: {
  limit?: number;
  order?: "asc" | "desc";
  includeArchived?: boolean;
  cursor?: string;
}): Environment[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const order = opts.order === "asc" ? "ASC" : "DESC";
  const includeArchived = opts.includeArchived ?? false;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!includeArchived) clauses.push("archived_at IS NULL");
  if (opts.cursor) {
    clauses.push(order === "DESC" ? "id < ?" : "id > ?");
    params.push(opts.cursor);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT * FROM environments ${where} ORDER BY id ${order} LIMIT ?`,
    )
    .all(...params, limit) as EnvironmentRow[];

  return rows.map(hydrate);
}

export function hasSessionsAttached(envId: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions
       WHERE environment_id = ? AND archived_at IS NULL AND status != 'terminated'`,
    )
    .get(envId) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}
