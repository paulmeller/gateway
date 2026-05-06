import { DEFAULT_TENANT_ID } from "./tenants";
import { eq, and, isNull, lt, gt, asc, desc, sql } from "drizzle-orm";
import { getDrizzle, schema } from "./drizzle";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type {
  Agent,
  AgentRow,
  AgentVersionRow,
  AgentSkill,
  BackendName,
  McpServerConfig,
  ModelConfig,
  ToolConfig,
} from "../types";

function hydrate(row: AgentRow, ver: AgentVersionRow): Agent {
  const modelConfig: ModelConfig = ver.model_config_json ? (JSON.parse(ver.model_config_json) as ModelConfig) : {};

  // Normalize mcp_servers: DB stores as record, API returns as array
  const rawMcp = ver.mcp_servers_json ? JSON.parse(ver.mcp_servers_json) : {};
  const mcpServers = Array.isArray(rawMcp)
    ? rawMcp
    : Object.entries(rawMcp).map(([name, cfg]) => ({
        name,
        type: "url",
        ...(typeof cfg === "string" ? { url: cfg } : (cfg as Record<string, unknown>)),
      }));

  return {
    type: "agent" as const,
    id: row.id,
    version: ver.version,
    name: row.name,
    description: row.description ?? "",
    model: { id: ver.model, ...(modelConfig.speed ? { speed: modelConfig.speed } : {}) },
    system: ver.system,
    tools: JSON.parse(ver.tools_json) as ToolConfig[],
    mcp_servers: mcpServers,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    engine: (ver.backend ?? "claude") as BackendName,
    webhook_url: ver.webhook_url ?? null,
    webhook_events: ver.webhook_events_json ? (JSON.parse(ver.webhook_events_json) as string[]) : ["session.status_idle", "session.status_running", "session.error"],
    webhook_signing_enabled: ver.webhook_secret != null && ver.webhook_secret.length > 0,
    threads_enabled: Boolean(ver.threads_enabled),
    confirmation_mode: Boolean(ver.confirmation_mode),
    callable_agents: ver.callable_agents_json ? JSON.parse(ver.callable_agents_json) : [],
    skills: ver.skills_json ? (JSON.parse(ver.skills_json) as AgentSkill[]) : [],
    model_config: modelConfig,
    fallback_json: row.fallback_json ?? null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    archived_at: row.archived_at ? new Date(row.archived_at).toISOString() : null,
  };
}

export function createAgent(input: {
  name: string;
  model: string;
  description?: string;
  metadata?: Record<string, string>;
  system?: string | null;
  tools?: ToolConfig[];
  mcp_servers?: Record<string, McpServerConfig>;
  backend?: BackendName;
  webhook_url?: string | null;
  webhook_events?: string[];
  /** v0.5: HMAC-SHA256 shared secret for webhook payload signing. */
  webhook_secret?: string | null;
  threads_enabled?: boolean;
  confirmation_mode?: boolean;
  callable_agents?: Array<{ type: "agent"; id: string; version?: number }>;
  skills?: AgentSkill[];
  model_config?: ModelConfig;
  /** v0.5: tenant ownership. Null = legacy/global (pre-migration). */
  tenant_id?: string | null;
}): Agent {
  const db = getDrizzle();
  const id = newId("agent");
  const now = nowMs();

  db.transaction((tx) => {
    tx.insert(schema.agents).values({
      id,
      current_version: 1,
      name: input.name,
      description: input.description ?? null,
      metadata_json: JSON.stringify(input.metadata ?? {}),
      tenant_id: input.tenant_id ?? DEFAULT_TENANT_ID,
      created_at: now,
      updated_at: now,
    }).run();

    tx.insert(schema.agentVersions).values({
      agent_id: id,
      version: 1,
      model: input.model,
      system: input.system ?? null,
      tools_json: JSON.stringify(input.tools ?? []),
      mcp_servers_json: JSON.stringify(input.mcp_servers ?? {}),
      backend: input.backend ?? "claude",
      webhook_url: input.webhook_url ?? null,
      webhook_events_json: JSON.stringify(input.webhook_events ?? ["session.status_idle", "session.status_running", "session.error"]),
      webhook_secret: input.webhook_secret ?? null,
      threads_enabled: input.threads_enabled ? 1 : 0,
      confirmation_mode: input.confirmation_mode ? 1 : 0,
      callable_agents_json: input.callable_agents?.length ? JSON.stringify(input.callable_agents) : null,
      skills_json: JSON.stringify(input.skills ?? []),
      model_config_json: JSON.stringify(input.model_config ?? {}),
      created_at: now,
    }).run();
  });

  return getAgent(id)!;
}

export function getAgent(id: string, version?: number): Agent | null {
  const db = getDrizzle();
  const row = db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, id))
    .get() as AgentRow | undefined;
  if (!row) return null;

  const v = version ?? row.current_version;
  const ver = db
    .select()
    .from(schema.agentVersions)
    .where(
      and(
        eq(schema.agentVersions.agent_id, id),
        eq(schema.agentVersions.version, v),
      ),
    )
    .get() as AgentVersionRow | undefined;
  if (!ver) return null;

  return hydrate(row, ver);
}

export function updateAgent(
  id: string,
  input: {
    name?: string;
    model?: string;
    description?: string;
    metadata?: Record<string, string>;
    system?: string | null;
    tools?: ToolConfig[];
    mcp_servers?: Record<string, McpServerConfig>;
    webhook_url?: string | null;
    webhook_events?: string[];
    /**
     * v0.5: pass a string to set/rotate the webhook signing secret, or
     * `null` to clear. `undefined` keeps the existing value (so PATCH
     * callers that don't mention the field won't accidentally nuke it).
     */
    webhook_secret?: string | null;
    threads_enabled?: boolean;
    confirmation_mode?: boolean;
    callable_agents?: Array<{ type: "agent"; id: string; version?: number }>;
    skills?: AgentSkill[];
    model_config?: ModelConfig;
  },
): Agent | null {
  const db = getDrizzle();
  const existing = getAgent(id);
  if (!existing) return null;

  // Need the raw existing version row for fields not surfaced via hydrate
  // (webhook_secret, raw mcp_servers_json for carry-forward).
  const existingVer = db
    .select({
      webhook_secret: schema.agentVersions.webhook_secret,
      mcp_servers_json: schema.agentVersions.mcp_servers_json,
    })
    .from(schema.agentVersions)
    .where(
      and(
        eq(schema.agentVersions.agent_id, id),
        eq(schema.agentVersions.version, existing.version),
      ),
    )
    .get() as { webhook_secret: string | null; mcp_servers_json: string } | undefined;
  const carriedSecret = existingVer?.webhook_secret ?? null;

  const newVersion = existing.version + 1;
  const now = nowMs();

  db.transaction((tx) => {
    tx.insert(schema.agentVersions).values({
      agent_id: id,
      version: newVersion,
      model: input.model ?? existing.model.id,
      system: input.system ?? existing.system,
      tools_json: JSON.stringify(input.tools ?? existing.tools),
      mcp_servers_json: input.mcp_servers ? JSON.stringify(input.mcp_servers) : (existingVer?.mcp_servers_json ?? "{}"),
      backend: existing.engine,
      webhook_url: input.webhook_url !== undefined ? input.webhook_url : existing.webhook_url,
      webhook_events_json: JSON.stringify(input.webhook_events ?? existing.webhook_events),
      webhook_secret: input.webhook_secret !== undefined ? input.webhook_secret : carriedSecret,
      threads_enabled: input.threads_enabled !== undefined ? (input.threads_enabled ? 1 : 0) : (existing.threads_enabled ? 1 : 0),
      confirmation_mode: input.confirmation_mode !== undefined ? (input.confirmation_mode ? 1 : 0) : (existing.confirmation_mode ? 1 : 0),
      callable_agents_json: input.callable_agents !== undefined ? (input.callable_agents.length ? JSON.stringify(input.callable_agents) : null) : (existing.callable_agents.length ? JSON.stringify(existing.callable_agents) : null),
      skills_json: JSON.stringify(input.skills ?? existing.skills),
      model_config_json: JSON.stringify(input.model_config !== undefined ? input.model_config : existing.model_config),
      created_at: now,
    }).run();

    tx.update(schema.agents)
      .set({
        current_version: newVersion,
        name: input.name ?? existing.name,
        description: input.description !== undefined ? (input.description ?? null) : (existing.description || null),
        metadata_json: input.metadata !== undefined ? JSON.stringify(input.metadata) : JSON.stringify(existing.metadata),
        updated_at: now,
      })
      .where(eq(schema.agents.id, id))
      .run();
  });

  return getAgent(id);
}

export function archiveAgent(id: string): boolean {
  const db = getDrizzle();
  const res = db
    .update(schema.agents)
    .set({ archived_at: nowMs() })
    .where(and(eq(schema.agents.id, id), isNull(schema.agents.archived_at)))
    .run();
  return res.changes > 0;
}

export function listAgents(opts: {
  limit?: number;
  order?: "asc" | "desc";
  includeArchived?: boolean;
  cursor?: string; // agent id cursor
  /**
   * v0.5 tenancy filter:
   * - `null` (global admin) → no filter
   * - `string` (tenant id) → WHERE tenant_id = ?
   * - `undefined` → also no filter (pre-v0.5 callers; default behavior preserved)
   */
  tenantFilter?: string | null;
}): Agent[] {
  const db = getDrizzle();
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const orderDir = opts.order === "asc" ? "asc" : "desc";
  const includeArchived = opts.includeArchived ?? false;

  const conditions = [];
  if (!includeArchived) conditions.push(isNull(schema.agents.archived_at));
  if (opts.cursor) {
    conditions.push(
      orderDir === "desc"
        ? lt(schema.agents.id, opts.cursor)
        : gt(schema.agents.id, opts.cursor),
    );
  }
  if (opts.tenantFilter != null) {
    conditions.push(eq(schema.agents.tenant_id, opts.tenantFilter));
  }
  const where = conditions.length ? and(...conditions) : undefined;

  const orderClause = orderDir === "desc" ? desc(schema.agents.id) : asc(schema.agents.id);

  const rows = (
    where
      ? db.select().from(schema.agents).where(where).orderBy(orderClause).limit(limit).all()
      : db.select().from(schema.agents).orderBy(orderClause).limit(limit).all()
  ) as AgentRow[];

  return rows.map((r) => getAgent(r.id)!).filter(Boolean);
}
