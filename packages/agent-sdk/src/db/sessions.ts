import { DEFAULT_TENANT_ID } from "./tenants";
import { eq, and, isNull, lt, gt, gte, lte, sql } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { Session, SessionResource, SessionRow, SessionStatus } from "../types";

export function hydrateSession(row: SessionRow): Session {
  // Populate resources from session_resources table if available,
  // falling back to resources_json for backward compat.
  let resources: SessionResource[];
  try {
    const { listResources } = require("./session-resources") as {
      listResources: (sessionId: string) => Array<{
        id: string;
        type: string;
        file_id?: string;
        mount_path?: string;
        url?: string;
        checkout_json?: string | null;
      }>;
    };
    const tableResources = listResources(row.id);
    if (tableResources.length > 0) {
      resources = tableResources.map((r) => {
        const base: SessionResource = { type: r.type as SessionResource["type"] };
        if (r.file_id) base.file_id = r.file_id;
        if (r.mount_path) base.mount_path = r.mount_path;
        if (r.url) {
          if (r.type === "github_repository") base.repository_url = r.url;
          else base.uri = r.url;
        }
        if (r.checkout_json) {
          try {
            const checkout = JSON.parse(r.checkout_json) as { type: string; name: string };
            if (checkout.type === "branch") base.branch = checkout.name;
            else if (checkout.type === "commit") base.commit = checkout.name;
          } catch { /* ignore */ }
        }
        return base;
      });
    } else {
      resources = row.resources_json ? (JSON.parse(row.resources_json) as SessionResource[]) : [];
    }
  } catch {
    // Fallback if session-resources module not available (e.g. table not migrated yet)
    resources = row.resources_json ? (JSON.parse(row.resources_json) as SessionResource[]) : [];
  }

  return {
    id: row.id,
    type: "session" as const,
    agent: { type: "agent" as const, id: row.agent_id, version: row.agent_version },
    environment_id: row.environment_id,
    status: row.status,
    stop_reason: row.stop_reason,
    title: row.title,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    max_budget_usd: row.max_budget_usd ?? null,
    outcome: row.outcome_criteria_json ? (JSON.parse(row.outcome_criteria_json) as Record<string, unknown>) : null,
    resources,
    vault_ids: row.vault_ids_json ? (JSON.parse(row.vault_ids_json) as string[]) : [],
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
  /** v0.4: the API key that authenticated this session creation, for cost attribution. */
  api_key_id?: string | null;
  /** v0.5: tenant ownership. Null = legacy/global (pre-migration). */
  tenant_id?: string | null;
}): Session {
  const db = getDrizzle();
  const id = newId("sess");
  const now = nowMs();

  db.insert(schema.sessions).values({
    id,
    agent_id: input.agent_id,
    agent_version: input.agent_version,
    environment_id: input.environment_id,
    status: "idle",
    title: input.title ?? null,
    metadata_json: JSON.stringify(input.metadata ?? {}),
    max_budget_usd: input.max_budget_usd ?? null,
    resources_json: input.resources ? JSON.stringify(input.resources) : null,
    vault_ids_json: input.vault_ids ? JSON.stringify(input.vault_ids) : null,
    parent_session_id: input.parent_session_id ?? null,
    thread_depth: input.thread_depth ?? 0,
    api_key_id: input.api_key_id ?? null,
    tenant_id: input.tenant_id ?? DEFAULT_TENANT_ID,
    created_at: now,
    updated_at: now,
  }).run();

  return getSession(id)!;
}

/**
 * List recent sessions owned by an API key. Used by the per-key activity
 * endpoint on the admin dashboard. Ordered by created_at DESC.
 */
export function listSessionsByApiKey(
  keyId: string,
  opts: { limit?: number; offset?: number } = {},
): Session[] {
  const db = getDrizzle();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const rows = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.api_key_id, keyId))
    .orderBy(sql`${schema.sessions.created_at} DESC`)
    .limit(limit)
    .offset(offset)
    .all() as SessionRow[];
  return rows.map(hydrateSession);
}

export function getSession(id: string): Session | null {
  const row = getSessionRow(id);
  return row ? hydrateSession(row) : null;
}

export function getSessionRow(id: string): SessionRow | null {
  const db = getDrizzle();
  return (
    (db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .get() as SessionRow | undefined) ?? null
  );
}

export function updateSessionStatus(
  id: string,
  status: SessionStatus,
  stopReason?: string | null,
): void {
  const db = getDrizzle();
  db.update(schema.sessions)
    .set({ status, stop_reason: stopReason ?? null, updated_at: nowMs() })
    .where(eq(schema.sessions.id, id))
    .run();
}

export function setSessionSprite(id: string, spriteName: string | null): void {
  const db = getDrizzle();
  db.update(schema.sessions)
    .set({ sprite_name: spriteName, updated_at: nowMs() })
    .where(eq(schema.sessions.id, id))
    .run();
}

/**
 * Store the backend's session id for subsequent resume turns. The DB column
 * is named `claude_session_id` for historical reasons but holds any
 * backend's session id (claude's `session_id`, opencode's `sessionID`).
 */
export function setBackendSessionId(id: string, backendSessionId: string): void {
  const db = getDrizzle();
  db.update(schema.sessions)
    .set({ claude_session_id: backendSessionId, updated_at: nowMs() })
    .where(eq(schema.sessions.id, id))
    .run();
}

export function setSessionProvider(id: string, providerName: string): void {
  const db = getDrizzle();
  db.update(schema.sessions)
    .set({ provider_name: providerName, updated_at: nowMs() })
    .where(eq(schema.sessions.id, id))
    .run();
}

export function setIdleSince(id: string, idleSince: number | null): void {
  const db = getDrizzle();
  db.update(schema.sessions)
    .set({ idle_since: idleSince })
    .where(eq(schema.sessions.id, id))
    .run();
}

export function updateSessionMutable(
  id: string,
  input: { title?: string | null; metadata?: Record<string, unknown> },
): Session | null {
  const db = getDrizzle();
  const existing = getSession(id);
  if (!existing) return null;

  db.update(schema.sessions)
    .set({
      title: input.title ?? existing.title,
      metadata_json: JSON.stringify(input.metadata ?? existing.metadata),
      updated_at: nowMs(),
    })
    .where(eq(schema.sessions.id, id))
    .run();

  return getSession(id);
}

export interface UsageDelta {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

/**
 * Bump session counters and (if the session has an api_key_id) the
 * owning key's spent_usd in a single transaction, so a crash between
 * the two can't cause permanent under-reporting.
 */
export function bumpSessionStats(
  id: string,
  delta: { turn_count?: number; tool_calls_count?: number; duration_seconds?: number; active_seconds?: number },
  usage?: UsageDelta,
): void {
  const db = getDrizzle();
  db.transaction((tx) => {
    tx.update(schema.sessions)
      .set({
        turn_count: sql`${schema.sessions.turn_count} + ${delta.turn_count ?? 0}`,
        tool_calls_count: sql`${schema.sessions.tool_calls_count} + ${delta.tool_calls_count ?? 0}`,
        active_seconds: sql`${schema.sessions.active_seconds} + ${delta.active_seconds ?? 0}`,
        duration_seconds: sql`${schema.sessions.duration_seconds} + ${delta.duration_seconds ?? 0}`,
        usage_input_tokens: sql`${schema.sessions.usage_input_tokens} + ${usage?.input_tokens ?? 0}`,
        usage_output_tokens: sql`${schema.sessions.usage_output_tokens} + ${usage?.output_tokens ?? 0}`,
        usage_cache_read_input_tokens: sql`${schema.sessions.usage_cache_read_input_tokens} + ${usage?.cache_read_input_tokens ?? 0}`,
        usage_cache_creation_input_tokens: sql`${schema.sessions.usage_cache_creation_input_tokens} + ${usage?.cache_creation_input_tokens ?? 0}`,
        usage_cost_usd: sql`${schema.sessions.usage_cost_usd} + ${usage?.cost_usd ?? 0}`,
        updated_at: nowMs(),
      })
      .where(eq(schema.sessions.id, id))
      .run();

    // Fold the key's running total into the same transaction. If the
    // session isn't attributed to a key, or the cost delta is zero, this
    // is a no-op.
    const costDelta = usage?.cost_usd ?? 0;
    if (costDelta !== 0) {
      tx.run(
        sql`UPDATE api_keys
            SET spent_usd = spent_usd + ${costDelta}
          WHERE id = (SELECT api_key_id FROM sessions WHERE id = ${id} AND api_key_id IS NOT NULL)`,
      );
    }
  });
}

export function archiveSession(id: string): boolean {
  const db = getDrizzle();
  const now = nowMs();
  const res = db
    .update(schema.sessions)
    .set({ archived_at: now, updated_at: now })
    .where(and(eq(schema.sessions.id, id), isNull(schema.sessions.archived_at)))
    .run();
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
  /** v0.5 tenancy filter. `null` = no filter (global admin). */
  tenantFilter?: string | null;
}): Session[] {
  const db = getDrizzle();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const orderDir = opts.order === "asc" ? "asc" : "desc";
  const includeArchived = opts.includeArchived ?? false;

  const conditions = [];

  if (opts.tenantFilter != null) conditions.push(eq(schema.sessions.tenant_id, opts.tenantFilter));
  if (opts.agent_id) conditions.push(eq(schema.sessions.agent_id, opts.agent_id));
  if (opts.agent_version != null) conditions.push(eq(schema.sessions.agent_version, opts.agent_version));
  if (opts.environmentId) conditions.push(eq(schema.sessions.environment_id, opts.environmentId));
  if (opts.parent_session_id) conditions.push(eq(schema.sessions.parent_session_id, opts.parent_session_id));
  if (opts.status) conditions.push(eq(schema.sessions.status, opts.status));
  if (!includeArchived) conditions.push(isNull(schema.sessions.archived_at));
  if (opts.createdGt != null) conditions.push(gt(schema.sessions.created_at, opts.createdGt));
  if (opts.createdGte != null) conditions.push(gte(schema.sessions.created_at, opts.createdGte));
  if (opts.createdLt != null) conditions.push(lt(schema.sessions.created_at, opts.createdLt));
  if (opts.createdLte != null) conditions.push(lte(schema.sessions.created_at, opts.createdLte));
  if (opts.cursor) {
    conditions.push(
      orderDir === "desc"
        ? lt(schema.sessions.id, opts.cursor)
        : gt(schema.sessions.id, opts.cursor),
    );
  }

  const where = conditions.length ? and(...conditions) : undefined;

  const orderClause =
    orderDir === "desc"
      ? sql`${schema.sessions.id} DESC`
      : sql`${schema.sessions.id} ASC`;

  const rows = (
    where
      ? db.select().from(schema.sessions).where(where).orderBy(orderClause).limit(limit).all()
      : db.select().from(schema.sessions).orderBy(orderClause).limit(limit).all()
  ) as SessionRow[];

  return rows.map(hydrateSession);
}

export function updateSessionResources(id: string, resourcesJson: string): void {
  const db = getDrizzle();
  db.update(schema.sessions)
    .set({ resources_json: resourcesJson, updated_at: nowMs() })
    .where(eq(schema.sessions.id, id))
    .run();
}

export function listIdleSessions(sessionMaxAgeMs: number, now: number, limit: number): SessionRow[] {
  const db = getDrizzle();
  // COALESCE so sessions that never ran a turn (idle_since IS NULL) still
  // age out from their created_at. LIMIT caps the worst case per sweep.
  return db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.status, "idle"),
        isNull(schema.sessions.archived_at),
        sql`COALESCE(${schema.sessions.idle_since}, ${schema.sessions.created_at}) + ${sessionMaxAgeMs} < ${now}`,
      ),
    )
    .limit(limit)
    .all() as SessionRow[];
}

export function setOutcomeCriteria(id: string, criteria: Record<string, unknown>): void {
  const db = getDrizzle();
  db.update(schema.sessions)
    .set({ outcome_criteria_json: JSON.stringify(criteria), updated_at: nowMs() })
    .where(eq(schema.sessions.id, id))
    .run();
}

export function getOutcomeCriteria(id: string): Record<string, unknown> | null {
  const row = getSessionRow(id);
  return row?.outcome_criteria_json ? (JSON.parse(row.outcome_criteria_json) as Record<string, unknown>) : null;
}
