import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type {
  Agent,
  AgentRow,
  AgentVersionRow,
  BackendName,
  McpServerConfig,
  ToolConfig,
} from "../types";

function hydrate(row: AgentRow, ver: AgentVersionRow): Agent {
  return {
    id: row.id,
    version: ver.version,
    name: row.name,
    model: ver.model,
    system: ver.system,
    tools: JSON.parse(ver.tools_json) as ToolConfig[],
    mcp_servers: JSON.parse(ver.mcp_servers_json) as Record<string, McpServerConfig>,
    engine: (ver.backend ?? "claude") as BackendName,
    webhook_url: ver.webhook_url ?? null,
    webhook_events: ver.webhook_events_json ? (JSON.parse(ver.webhook_events_json) as string[]) : ["session.status_idle", "session.status_running", "session.error"],
    threads_enabled: Boolean(ver.threads_enabled),
    confirmation_mode: Boolean(ver.confirmation_mode),
    callable_agents: ver.callable_agents_json ? JSON.parse(ver.callable_agents_json) : [],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function createAgent(input: {
  name: string;
  model: string;
  system?: string | null;
  tools?: ToolConfig[];
  mcp_servers?: Record<string, McpServerConfig>;
  backend?: BackendName;
  webhook_url?: string | null;
  webhook_events?: string[];
  threads_enabled?: boolean;
  confirmation_mode?: boolean;
  callable_agents?: Array<{ type: "agent"; id: string; version?: number }>;
}): Agent {
  const db = getDb();
  const id = newId("agent");
  const now = nowMs();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO agents (id, current_version, name, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)`,
    ).run(id, input.name, now, now);

    db.prepare(
      `INSERT INTO agent_versions
         (agent_id, version, model, system, tools_json, mcp_servers_json, backend, webhook_url, webhook_events_json, threads_enabled, confirmation_mode, callable_agents_json, created_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.model,
      input.system ?? null,
      JSON.stringify(input.tools ?? []),
      JSON.stringify(input.mcp_servers ?? {}),
      input.backend ?? "claude",
      input.webhook_url ?? null,
      JSON.stringify(input.webhook_events ?? ["session.status_idle", "session.status_running", "session.error"]),
      input.threads_enabled ? 1 : 0,
      input.confirmation_mode ? 1 : 0,
      input.callable_agents?.length ? JSON.stringify(input.callable_agents) : null,
      now,
    );
  });
  tx();

  return getAgent(id)!;
}

export function getAgent(id: string, version?: number): Agent | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM agents WHERE id = ?`)
    .get(id) as AgentRow | undefined;
  if (!row) return null;

  const v = version ?? row.current_version;
  const ver = db
    .prepare(
      `SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?`,
    )
    .get(id, v) as AgentVersionRow | undefined;
  if (!ver) return null;

  return hydrate(row, ver);
}

export function updateAgent(
  id: string,
  input: {
    name?: string;
    model?: string;
    system?: string | null;
    tools?: ToolConfig[];
    mcp_servers?: Record<string, McpServerConfig>;
    webhook_url?: string | null;
    webhook_events?: string[];
    threads_enabled?: boolean;
    confirmation_mode?: boolean;
    callable_agents?: Array<{ type: "agent"; id: string; version?: number }>;
  },
): Agent | null {
  const db = getDb();
  const existing = getAgent(id);
  if (!existing) return null;

  const newVersion = existing.version + 1;
  const now = nowMs();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_versions
         (agent_id, version, model, system, tools_json, mcp_servers_json, backend, webhook_url, webhook_events_json, threads_enabled, confirmation_mode, callable_agents_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      newVersion,
      input.model ?? existing.model,
      input.system ?? existing.system,
      JSON.stringify(input.tools ?? existing.tools),
      JSON.stringify(input.mcp_servers ?? existing.mcp_servers),
      existing.engine,
      input.webhook_url !== undefined ? input.webhook_url : existing.webhook_url,
      JSON.stringify(input.webhook_events ?? existing.webhook_events),
      input.threads_enabled !== undefined ? (input.threads_enabled ? 1 : 0) : (existing.threads_enabled ? 1 : 0),
      input.confirmation_mode !== undefined ? (input.confirmation_mode ? 1 : 0) : (existing.confirmation_mode ? 1 : 0),
      input.callable_agents !== undefined ? (input.callable_agents.length ? JSON.stringify(input.callable_agents) : null) : (existing.callable_agents.length ? JSON.stringify(existing.callable_agents) : null),
      now,
    );

    db.prepare(
      `UPDATE agents SET current_version = ?, name = ?, updated_at = ? WHERE id = ?`,
    ).run(newVersion, input.name ?? existing.name, now, id);
  });
  tx();

  return getAgent(id);
}

export function archiveAgent(id: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE agents SET archived_at = ? WHERE id = ? AND archived_at IS NULL`)
    .run(nowMs(), id);
  return res.changes > 0;
}

export function listAgents(opts: {
  limit?: number;
  order?: "asc" | "desc";
  includeArchived?: boolean;
  cursor?: string; // agent id cursor
}): Agent[] {
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
      `SELECT * FROM agents ${where} ORDER BY id ${order} LIMIT ?`,
    )
    .all(...params, limit) as AgentRow[];

  return rows.map((r) => getAgent(r.id)!).filter(Boolean);
}
