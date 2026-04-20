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
export type BackendName = "claude" | "opencode" | "codex" | "anthropic" | "gemini" | "factory" | "pi";
/** API-facing alias for BackendName. */
export type EngineName = BackendName;

export interface AgentRow {
  id: string;
  current_version: number;
  name: string;
  /**
   * v0.4+: JSON array of FallbackTuple {agent_id, environment_id} tuples
   * tried when the primary session-creation fails with a classifiable
   * (retryable or 5xx) error. Null when no fallbacks configured.
   */
  fallback_json: string | null;
  /** v0.5: tenant ownership. Null = legacy/global (pre-migration). */
  tenant_id: string | null;
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
  /**
   * v0.5: shared secret used to HMAC-sign webhook payloads. When set,
   * deliveries include `X-AgentStep-Signature: sha256=<hex>`. Null for
   * agents created pre-0.5 or intentionally unsigned webhooks.
   */
  webhook_secret: string | null;
  threads_enabled: number;
  confirmation_mode: number;
  callable_agents_json: string | null;
  skills_json: string;
  model_config_json: string;
  created_at: number;
}

export interface ModelConfig {
  speed?: "standard" | "fast";
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
  /**
   * Indicates whether a webhook shared secret is configured. The
   * secret itself is never returned over the API — only this boolean.
   */
  webhook_signing_enabled: boolean;
  threads_enabled: boolean;
  confirmation_mode: boolean;
  callable_agents: Array<{ type: "agent"; id: string; version?: number }>;
  skills: AgentSkill[];
  model_config: ModelConfig;
  /** Raw JSON — parse with parseFallbackJson in handlers. Null when unset. */
  fallback_json: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export type EnvironmentState = "preparing" | "ready" | "failed";

export interface EnvironmentConfig {
  type: "cloud";
  provider?: "sprites" | "docker" | "apple-container" | "apple-firecracker" | "podman" | "e2b" | "vercel" | "daytona" | "fly" | "modal" | "mvm" | "anthropic";
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
  description: string | null;
  config_json: string;
  metadata_json: string;
  state: EnvironmentState;
  state_message: string | null;
  template_sprite: string | null;
  checkpoint_id: string | null;
  /** v0.5: tenant ownership. Null = legacy/global (pre-migration). */
  tenant_id: string | null;
  created_at: number;
  archived_at: number | null;
}

export interface Environment {
  id: string;
  name: string;
  description: string | null;
  config: EnvironmentConfig;
  metadata: Record<string, string>;
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
  /** v0.4+: API key that authenticated the session creation. Null for pre-0.4 rows. */
  api_key_id: string | null;
  /** v0.5: tenant ownership. Null = legacy/global (pre-migration). */
  tenant_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface SessionResource {
  type: "uri" | "text" | "file" | "github_repository";
  uri?: string;
  content?: string;
  file_id?: string;
  mount_path?: string;
  repository_url?: string;
  branch?: string;
  commit?: string;
}

export interface Session {
  id: string;
  type: "session";
  agent: { type: "agent"; id: string; version: number };
  environment_id: string;
  status: SessionStatus;
  stop_reason: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  max_budget_usd: number | null;
  outcome: Record<string, unknown> | null;
  resources: SessionResource[];
  vault_ids: string[];
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
  /** v0.5: tenant ownership. Null = legacy/global (pre-migration). */
  tenant_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface Vault {
  id: string;
  agent_id: string;
  name: string;
  /** Anthropic-compatible alias for `name`. */
  display_name: string;
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
// Vault Credentials (Anthropic-compatible)
// ---------------------------------------------------------------------------

export interface VaultCredentialRow {
  id: string;
  vault_id: string;
  display_name: string;
  auth_type: string;
  auth_token_encrypted: string;
  mcp_server_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface VaultCredential {
  id: string;
  vault_id: string;
  display_name: string;
  auth: {
    type: string;
    mcp_server_url: string | null;
  };
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Memory Stores
// ---------------------------------------------------------------------------

export interface MemoryStoreRow {
  id: string;
  name: string;
  description: string | null;
  /** v0.5: owning agent. Null for legacy (pre-v0.5) global stores. */
  agent_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryStore {
  id: string;
  name: string;
  description: string | null;
  agent_id: string | null;
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
  /** OTel-style trace id — shared across all events of one top-level run. */
  trace_id: string | null;
  /** Span the event belongs to (either a boundary or inside the open span). */
  span_id: string | null;
  /** Parent span of `span_id`. Only meaningful on span.*_start events. */
  parent_span_id: string | null;
}

export interface ManagedEvent {
  id: string;
  seq: number;
  session_id: string;
  type: string;
  processed_at: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  parent_span_id?: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Auth — virtual keys with scope + admin
// ---------------------------------------------------------------------------

/**
 * A scope restricts which resources an API key can reach. The `"*"` sentinel
 * in any array means "all resources of this type". A field missing or `null`
 * at the top level (`scope: null`) means unrestricted — equivalent to having
 * every resource type set to `["*"]`.
 */
export interface KeyScope {
  agents: string[];
  environments: string[];
  vaults: string[];
}

export interface KeyPermissions {
  /** Admin keys can CRUD /v1/api-keys (and in v0.5, /v1/tenants and /v1/upstream-keys). */
  admin: boolean;
  /** null = unrestricted within whatever tenancy applies (v0.4: none). */
  scope: KeyScope | null;
}

export interface AuthContext {
  keyId: string;
  name: string;
  permissions: KeyPermissions;
  /**
   * The tenant this key belongs to. Null = global admin (cross-tenant visibility).
   * All non-global-admin operations filter by this tenant.
   */
  tenantId: string | null;
  /** Convenience: tenantId === null && permissions.admin. */
  isGlobalAdmin: boolean;
  /** Null = unlimited. In USD. Enforced in the driver pre-turn. */
  budgetUsd: number | null;
  /** Null = unlimited. Fixed 60-second window enforced in routeWrap. */
  rateLimitRpm: number | null;
  /** Running total of USD spent by this key. Updated transactionally alongside session usage. */
  spentUsd: number;
}

// ---------------------------------------------------------------------------
// Tenants (v0.5)
// ---------------------------------------------------------------------------

export interface TenantRow {
  id: string;
  name: string;
  created_at: number;
  archived_at: number | null;
}

export interface Tenant {
  id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
}

// ---------------------------------------------------------------------------
// Audit log (v0.5 PR4c)
// ---------------------------------------------------------------------------

/** "success" for a committed action, "denied" for auth/403, "failure" for unexpected errors. */
export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditLogRow {
  id: string;
  created_at: number;
  /** Key id of the caller, or null for system-initiated events. */
  actor_key_id: string | null;
  /** Friendly actor name captured at log time (keys can be renamed later). */
  actor_name: string | null;
  /** Tenant the action was scoped to. Null for global-scope ops. */
  tenant_id: string | null;
  /** Dotted verb: `tenants.create`, `api_keys.revoke`, `upstream_keys.add`, ... */
  action: string;
  /** "agent" | "tenant" | "api_key" | "upstream_key" | "session" | null. */
  resource_type: string | null;
  /** Resource id, when applicable. */
  resource_id: string | null;
  outcome: AuditOutcome;
  /** Arbitrary action-specific context, JSON-encoded. */
  metadata_json: string | null;
}

export interface AuditLogEntry {
  id: string;
  created_at: string;
  actor_key_id: string | null;
  actor_name: string | null;
  tenant_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  outcome: AuditOutcome;
  metadata: Record<string, unknown> | null;
}
