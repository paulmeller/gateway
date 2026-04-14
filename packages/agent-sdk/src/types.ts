/**
 * Shared TypeScript types for managed-agents.
 *
 * Resource shapes mirror the Claude Managed Agents API as closely as possible
 * so that the `@anthropic-ai/sdk` (with `baseURL` override) can be used as a
 * client against this service.
 */

// ---------------------------------------------------------------------------
// Tool config (mirrors agent_toolset_20260401)
// ---------------------------------------------------------------------------

export const BUILT_IN_TOOL_NAMES = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
] as const;

export type BuiltInToolName = (typeof BUILT_IN_TOOL_NAMES)[number];

export interface AgentToolsetTool {
  type: "agent_toolset_20260401";
  configs?: Array<{ name: string; enabled?: boolean }>;
  default_config?: { enabled?: boolean };
}

export interface CustomTool {
  type: "custom";
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type ToolConfig = AgentToolsetTool | CustomTool;

export interface McpServerConfig {
  type?: "stdio" | "http" | "sse";
  url?: string;
  command?: string | string[];
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Agent / AgentVersion
// ---------------------------------------------------------------------------

/**
 * Which CLI engine powers a session's turns. Declared locally (not imported
 * from lib/backends/types.ts) to avoid a circular import between types and
 * the backend registry.
 */
export type BackendName = "claude" | "opencode" | "codex" | "anthropic" | "gemini" | "factory";
/** API-facing alias for BackendName. */
export type EngineName = BackendName;

export interface AgentRow {
  id: string;
  current_version: number;
  name: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface AgentVersionRow {
  agent_id: string;
  version: number;
  model: string;
  system: string | null;
  tools_json: string;
  mcp_servers_json: string;
  backend: BackendName;
  webhook_url: string | null;
  webhook_events_json: string;
  threads_enabled: number;
  confirmation_mode: number;
  callable_agents_json: string | null;
  skills_json: string;
  created_at: number;
}

export interface AgentSkill {
  name: string;
  source: string;
  content: string;
  installed_at: string;
}

export interface Agent {
  id: string;
  version: number;
  name: string;
  model: string;
  system: string | null;
  tools: ToolConfig[];
  mcp_servers: Record<string, McpServerConfig>;
  engine: EngineName;
  webhook_url: string | null;
  webhook_events: string[];
  threads_enabled: boolean;
  confirmation_mode: boolean;
  callable_agents: Array<{ type: "agent"; id: string; version?: number }>;
  skills: AgentSkill[];
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export type EnvironmentState = "preparing" | "ready" | "failed";

export interface EnvironmentConfig {
  type: "cloud";
  provider?: "sprites" | "docker" | "apple-container" | "apple-firecracker" | "podman" | "e2b" | "vercel" | "daytona" | "fly" | "modal" | "mvm";
  packages?: {
    apt?: string[];
    cargo?: string[];
    gem?: string[];
    go?: string[];
    npm?: string[];
    pip?: string[];
  };
  networking?:
    | { type: "unrestricted" }
    | {
        type: "limited";
        allowed_hosts?: string[];
        allow_mcp_servers?: boolean;
        allow_package_managers?: boolean;
      };
}

export interface EnvironmentRow {
  id: string;
  name: string;
  config_json: string;
  state: EnvironmentState;
  state_message: string | null;
  template_sprite: string | null;
  checkpoint_id: string | null;
  created_at: number;
  archived_at: number | null;
}

export interface Environment {
  id: string;
  name: string;
  config: EnvironmentConfig;
  state: EnvironmentState;
  state_message: string | null;
  created_at: string;
  archived_at: string | null;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type SessionStatus = "idle" | "running" | "rescheduling" | "terminated";

export interface SessionRow {
  id: string;
  agent_id: string;
  agent_version: number;
  environment_id: string;
  sprite_name: string | null;
  claude_session_id: string | null;
  status: SessionStatus;
  stop_reason: string | null;
  title: string | null;
  metadata_json: string;
  turn_count: number;
  tool_calls_count: number;
  active_seconds: number;
  duration_seconds: number;
  usage_input_tokens: number;
  usage_output_tokens: number;
  usage_cache_read_input_tokens: number;
  usage_cache_creation_input_tokens: number;
  usage_cost_usd: number;
  last_seq: number;
  idle_since: number | null;
  parked_checkpoint_id: string | null;
  provider_name: string;
  max_budget_usd: number | null;
  outcome_criteria_json: string | null;
  resources_json: string | null;
  vault_ids_json: string | null;
  parent_session_id: string | null;
  thread_depth: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface SessionResource {
  type: "uri" | "text";
  uri?: string;
  content?: string;
}

export interface Session {
  id: string;
  agent: { id: string; version: number };
  environment_id: string;
  status: SessionStatus;
  stop_reason: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  max_budget_usd: number | null;
  outcome: Record<string, unknown> | null;
  resources: SessionResource[] | null;
  vault_ids: string[] | null;
  parent_session_id: string | null;
  thread_depth: number;
  stats: {
    turn_count: number;
    tool_calls_count: number;
    active_seconds: number;
    duration_seconds: number;
  };
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    cost_usd: number;
  };
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

export interface VaultRow {
  id: string;
  agent_id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

export interface Vault {
  id: string;
  agent_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface VaultEntryRow {
  vault_id: string;
  key: string;
  value: string;
  updated_at: number;
}

export interface VaultEntry {
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Memory Stores
// ---------------------------------------------------------------------------

export interface MemoryStoreRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryStore {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryRow {
  id: string;
  store_id: string;
  path: string;
  content: string;
  content_sha256: string;
  created_at: number;
  updated_at: number;
}

export interface Memory {
  id: string;
  store_id: string;
  path: string;
  content: string;
  content_sha256: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventOrigin = "user" | "server";

export interface EventRow {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  payload_json: string;
  processed_at: number | null;
  received_at: number;
  origin: EventOrigin;
  idempotency_key: string | null;
}

export interface ManagedEvent {
  id: string;
  seq: number;
  session_id: string;
  type: string;
  processed_at: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthContext {
  keyId: string;
  name: string;
  permissions: string[];
}
