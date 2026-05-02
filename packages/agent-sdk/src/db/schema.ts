/**
 * Drizzle ORM schema — declarative table definitions for all 14 tables.
 *
 * This is the source of truth for column names, types, and defaults.
 * The actual CREATE TABLE + ALTER TABLE migrations still run in
 * migrations.ts (idempotent, PRAGMA-guarded). Drizzle doesn't
 * *create* the tables — it just types the queries against them.
 *
 * Tables are added incrementally as each db-layer file is migrated.
 */
import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";

// ── settings ──────────────────────────────────────────────────────────

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  type: text("type").notNull().default("text"),
  updated_at: integer("updated_at"),
});

// ── proxy_resources ───────────────────────────────────────────────────

export const proxyResources = sqliteTable("proxy_resources", {
  resource_id: text("resource_id").primaryKey(),
  resource_type: text("resource_type").notNull(),
  // v0.5 ALTER TABLE addition:
  tenant_id: text("tenant_id"),
  created_at: integer("created_at").notNull(),
});

// ── api_keys ──────────────────────────────────────────────────────────

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  hash: text("hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  permissions_json: text("permissions_json").notNull().default("[]"),
  // v0.4 ALTER TABLE additions:
  tenant_id: text("tenant_id"),
  budget_usd: real("budget_usd"),
  rate_limit_rpm: integer("rate_limit_rpm"),
  spent_usd: real("spent_usd").notNull().default(0),
  created_at: integer("created_at").notNull(),
  revoked_at: integer("revoked_at"),
});

// ── agents ────────────────────────────────────────────────────────────

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  current_version: integer("current_version").notNull(),
  name: text("name").notNull(),
  // v0.4 ALTER TABLE addition:
  fallback_json: text("fallback_json"),
  // v0.5 ALTER TABLE addition:
  tenant_id: text("tenant_id"),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  archived_at: integer("archived_at"),
});

// ── agent_versions ────────────────────────────────────────────────────

export const agentVersions = sqliteTable("agent_versions", {
  agent_id: text("agent_id").notNull(),
  version: integer("version").notNull(),
  model: text("model").notNull(),
  system: text("system"),
  tools_json: text("tools_json").notNull().default("[]"),
  mcp_servers_json: text("mcp_servers_json").notNull().default("{}"),
  backend: text("backend").notNull().default("claude"),
  webhook_url: text("webhook_url"),
  webhook_events_json: text("webhook_events_json").notNull().default('["session.status_idle","session.status_running","session.error"]'),
  threads_enabled: integer("threads_enabled").notNull().default(0),
  confirmation_mode: integer("confirmation_mode").notNull().default(0),
  callable_agents_json: text("callable_agents_json"),
  skills_json: text("skills_json").notNull().default("[]"),
  model_config_json: text("model_config_json").notNull().default("{}"),
  // v0.5 ALTER TABLE addition:
  webhook_secret: text("webhook_secret"),
  created_at: integer("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.agent_id, table.version] }),
]);

// ── environments ──────────────────────────────────────────────────────

export const environments = sqliteTable("environments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  config_json: text("config_json").notNull(),
  metadata_json: text("metadata_json").notNull().default("{}"),
  state: text("state").notNull().default("preparing"),
  state_message: text("state_message"),
  template_sandbox: text("template_sandbox"),
  checkpoint_id: text("checkpoint_id"),
  // v0.5 ALTER TABLE addition:
  tenant_id: text("tenant_id"),
  created_at: integer("created_at").notNull(),
  archived_at: integer("archived_at"),
});

// ── sessions ──────────────────────────────────────────────────────────

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agent_id: text("agent_id").notNull(),
  agent_version: integer("agent_version").notNull(),
  environment_id: text("environment_id").notNull(),
  sandbox_name: text("sandbox_name"),
  claude_session_id: text("claude_session_id"),
  status: text("status").notNull().default("idle"),
  stop_reason: text("stop_reason"),
  title: text("title"),
  metadata_json: text("metadata_json").notNull().default("{}"),
  turn_count: integer("turn_count").notNull().default(0),
  tool_calls_count: integer("tool_calls_count").notNull().default(0),
  active_seconds: real("active_seconds").notNull().default(0),
  duration_seconds: real("duration_seconds").notNull().default(0),
  usage_input_tokens: integer("usage_input_tokens").notNull().default(0),
  usage_output_tokens: integer("usage_output_tokens").notNull().default(0),
  usage_cache_read_input_tokens: integer("usage_cache_read_input_tokens").notNull().default(0),
  usage_cache_creation_input_tokens: integer("usage_cache_creation_input_tokens").notNull().default(0),
  usage_cost_usd: real("usage_cost_usd").notNull().default(0),
  last_seq: integer("last_seq").notNull().default(0),
  idle_since: integer("idle_since"),
  parked_checkpoint_id: text("parked_checkpoint_id"),
  provider_name: text("provider_name").notNull().default("sprites"),
  max_budget_usd: real("max_budget_usd"),
  max_tokens: integer("max_tokens"),
  max_wall_duration_ms: integer("max_wall_duration_ms"),
  outcome_criteria_json: text("outcome_criteria_json"),
  resources_json: text("resources_json"),
  vault_ids_json: text("vault_ids_json"),
  parent_session_id: text("parent_session_id"),
  thread_depth: integer("thread_depth").notNull().default(0),
  // v0.4 ALTER TABLE addition:
  api_key_id: text("api_key_id"),
  // v0.5 ALTER TABLE addition:
  tenant_id: text("tenant_id"),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
  archived_at: integer("archived_at"),
});

// ── events ────────────────────────────────────────────────────────────

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  session_id: text("session_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload_json: text("payload_json").notNull(),
  processed_at: integer("processed_at"),
  received_at: integer("received_at").notNull(),
  origin: text("origin").notNull(),
  idempotency_key: text("idempotency_key"),
  trace_id: text("trace_id"),
  span_id: text("span_id"),
  parent_span_id: text("parent_span_id"),
});

// ── vaults ────────────────────────────────────────────────────────────

export const vaults = sqliteTable("vaults", {
  id: text("id").primaryKey(),
  agent_id: text("agent_id").notNull(),
  name: text("name").notNull(),
  // v0.5 ALTER TABLE addition:
  tenant_id: text("tenant_id"),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
});

// ── vault_entries ─────────────────────────────────────────────────────

export const vaultEntries = sqliteTable("vault_entries", {
  vault_id: text("vault_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  updated_at: integer("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.vault_id, table.key] }),
]);

// ── memory_stores ─────────────────────────────────────────────────────

export const memoryStores = sqliteTable("memory_stores", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  agent_id: text("agent_id"),
  metadata_json: text("metadata_json").notNull().default("{}"),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
});

// ── memories ──────────────────────────────────────────────────────────

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  store_id: text("store_id").notNull(),
  path: text("path").notNull(),
  content: text("content").notNull(),
  content_sha256: text("content_sha256").notNull(),
  metadata_json: text("metadata_json").notNull().default("{}"),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
});

// ── files ─────────────────────────────────────────────────────────────

export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  size: integer("size").notNull(),
  content_type: text("content_type").notNull(),
  storage_path: text("storage_path").notNull(),
  scope_type: text("scope_type"),
  scope_id: text("scope_id"),
  // v0.5 ALTER TABLE additions (container file sync):
  container_path: text("container_path"),
  content_hash: text("content_hash"),
  created_at: integer("created_at").notNull(),
});

// ── session_resources ────────────────────────────────────────────────

export const sessionResources = sqliteTable("session_resources", {
  id: text("id").primaryKey(),
  session_id: text("session_id").notNull(),
  type: text("type").notNull(), // "file" | "github_repository" | "uri" | "text"
  file_id: text("file_id"),
  mount_path: text("mount_path"),
  url: text("url"),
  checkout_json: text("checkout_json"),
  created_at: integer("created_at").notNull(),
  updated_at: integer("updated_at").notNull(),
});

// ── anthropic_sync ────────────────────────────────────────────────────

export const anthropicSync = sqliteTable("anthropic_sync", {
  local_id: text("local_id").notNull(),
  resource_type: text("resource_type").notNull(),
  remote_id: text("remote_id").notNull(),
  synced_at: integer("synced_at").notNull(),
  config_hash: text("config_hash"),
}, (table) => [
  primaryKey({ columns: [table.local_id, table.resource_type] }),
]);
