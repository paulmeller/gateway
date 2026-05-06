import { DEFAULT_TENANT_ID } from "./tenants";
import { eq, and, isNull, lt, gt, sql } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { Environment, EnvironmentConfig, EnvironmentRow, EnvironmentState } from "../types";

function hydrate(row: EnvironmentRow): Environment {
  return {
    type: "environment" as const,
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
  /** v0.5: tenant ownership. Null = legacy/global (pre-migration). */
  tenant_id?: string | null;
}): Environment {
  const db = getDrizzle();
  const id = newId("env");
  const now = nowMs();

  db.insert(schema.environments).values({
    id,
    name: input.name,
    description: input.description ?? null,
    config_json: JSON.stringify(input.config),
    metadata_json: JSON.stringify(input.metadata ?? {}),
    tenant_id: input.tenant_id ?? DEFAULT_TENANT_ID,
    state: "preparing",
    created_at: now,
  }).run();

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
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.environments)
    .where(eq(schema.environments.id, id))
    .get() as EnvironmentRow | undefined;
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

  db.update(schema.environments)
    .set({
      name: newName,
      description: newDescription ?? null,
      config_json: newConfigJson,
      metadata_json: newMetadataJson,
    })
    .where(eq(schema.environments.id, id))
    .run();

  return getEnvironment(id);
}

export function getEnvironment(id: string): Environment | null {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.environments)
    .where(eq(schema.environments.id, id))
    .get() as EnvironmentRow | undefined;
  return row ? hydrate(row) : null;
}

export function getEnvironmentRow(id: string): EnvironmentRow | null {
  const db = getDrizzle();
  return (
    (db
      .select()
      .from(schema.environments)
      .where(eq(schema.environments.id, id))
      .get() as EnvironmentRow | undefined) ?? null
  );
}

export function updateEnvironmentState(
  id: string,
  state: EnvironmentState,
  message?: string | null,
): void {
  const db = getDrizzle();
  db.update(schema.environments)
    .set({ state, state_message: message ?? null })
    .where(eq(schema.environments.id, id))
    .run();
}

export function updateEnvironmentCheckpoint(
  id: string,
  checkpointId: string,
  templateSprite: string | null,
): void {
  const db = getDrizzle();
  db.update(schema.environments)
    .set({ checkpoint_id: checkpointId, template_sandbox: templateSprite })
    .where(eq(schema.environments.id, id))
    .run();
}

export function archiveEnvironment(id: string): boolean {
  const db = getDrizzle();
  const res = db
    .update(schema.environments)
    .set({ archived_at: nowMs() })
    .where(and(eq(schema.environments.id, id), isNull(schema.environments.archived_at)))
    .run();
  return res.changes > 0;
}

export function deleteEnvironment(id: string): boolean {
  const db = getDrizzle();
  // Archive any sessions referencing this environment to avoid FK constraint
  db.update(schema.sessions)
    .set({ archived_at: nowMs() })
    .where(
      and(
        eq(schema.sessions.environment_id, id),
        isNull(schema.sessions.archived_at),
      ),
    )
    .run();
  const res = db.delete(schema.environments).where(eq(schema.environments.id, id)).run();
  return res.changes > 0;
}

export function listEnvironments(opts: {
  limit?: number;
  order?: "asc" | "desc";
  includeArchived?: boolean;
  cursor?: string;
  /** v0.5 tenancy filter. `null` = no filter (global admin). See listAgents. */
  tenantFilter?: string | null;
}): Environment[] {
  const db = getDrizzle();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const orderDir = opts.order === "asc" ? "asc" : "desc";
  const includeArchived = opts.includeArchived ?? false;

  const conditions = [];
  if (!includeArchived) conditions.push(isNull(schema.environments.archived_at));
  if (opts.cursor) {
    conditions.push(
      orderDir === "desc"
        ? lt(schema.environments.id, opts.cursor)
        : gt(schema.environments.id, opts.cursor),
    );
  }
  if (opts.tenantFilter != null) {
    conditions.push(eq(schema.environments.tenant_id, opts.tenantFilter));
  }

  const where = conditions.length ? and(...conditions) : undefined;
  const orderClause =
    orderDir === "desc"
      ? sql`${schema.environments.id} DESC`
      : sql`${schema.environments.id} ASC`;

  const rows = (
    where
      ? db.select().from(schema.environments).where(where).orderBy(orderClause).limit(limit).all()
      : db.select().from(schema.environments).orderBy(orderClause).limit(limit).all()
  ) as EnvironmentRow[];

  return rows.map(hydrate);
}

export function hasSessionsAttached(envId: string): boolean {
  const db = getDrizzle();
  const row = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.environment_id, envId),
        isNull(schema.sessions.archived_at),
        sql`${schema.sessions.status} != 'terminated'`,
      ),
    )
    .get();
  return ((row as { n: number } | undefined)?.n ?? 0) > 0;
}
