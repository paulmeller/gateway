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
  "ToolSearch",
  "Skill",
  "Agent",
  "NotebookEdit",
  "TodoWrite",
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
  description: string | null;
  metadata_json: string;
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
  multiagent_json: string | null;
  permission_policy_json: string | null;
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
  /** All files in the skill directory (relative path → content). Binary files use "base64:" prefix. */
  files?: Record<string, string>;
  installed_at: string;
}

export interface Agent {
  type: "agent";
  id: string;
  version: number;
  name: string;
  description: string;
  model: { id: string; speed?: "standard" | "fast" };
  system: string | null;
  tools: ToolConfig[];
  mcp_servers: Array<{ name: string; type: string; url?: string; [key: string]: unknown }>;
  metadata: Record<string, string>;
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
  multiagent?: {
    type: "coordinator";
    agents: Array<{ type: "agent"; id: string; version?: number } | { type: "self" }>;
  };
  permission_policy?: {
    always_allow?: string[];
    always_ask?: string[];
  } | null;
  skills: AgentSkill[];
  model_config: ModelConfig;
  /** Raw JSON — parse with parseFallbackJson in handlers. Null when unset. */
  fallback_json: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

// ---------------------------------------------------------------------------
// Work Queue
// ---------------------------------------------------------------------------

export type WorkState = "queued" | "pending" | "active" | "completed" | "failed";

export interface WorkItem {
  type: "work";
  id: string;
  environment_id: string;
  state: WorkState;
  data: { type: "session"; id: string };
  metadata: Record<string, string>;
  worker_id: string | null;
  created_at: string;
  acknowledged_at: string | null;
  started_at: string | null;
  latest_heartbeat_at: string | null;
  stop_requested_at: string | null;
  stopped_at: string | null;
}

export interface WorkQueueStats {
  type: "work_queue_stats";
  depth: number;
  pending: number;
  workers_polling: number | null;
  oldest_queued_at: string | null;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export type EnvironmentState = "preparing" | "ready" | "failed";

export interface EnvironmentConfig {
  type: "cloud" | "self_hosted";
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
  /** Per-environment warm pool size override. Null/undefined = use global `WARM_POOL_SIZE`. */
  warm_pool_size?: number;
  /** Per-environment idle timeout override (ms). Null/undefined = use global `sessionMaxAgeMs`. */
  idle_timeout_ms?: number;
  /** Per-environment max sandboxes override. Null/undefined = use global `maxSandboxesPerEnv`. */
  max_sandboxes?: number;
  /** Default engine for warm pool containers. Null/undefined = "claude". */
  default_engine?: string;
}

export interface EnvironmentRow {
  id: string;
  name: string;
  description: string | null;
  config_json: string;
  metadata_json: string;
  state: EnvironmentState;
  state_message: string | null;
  template_sandbox: string | null;
  checkpoint_id: string | null;
  /** v0.5: tenant ownership. Null = legacy/global (pre-migration). */
  tenant_id: string | null;

  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface Environment {
  type: "environment";
  id: string;
  name: string;
  description: string | null;
  config: EnvironmentConfig;
  metadata: Record<string, string>;
  state: EnvironmentState;
  state_message: string | null;
  created_at: string;
  updated_at: string;
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
  sandbox_name: string | null;
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
  max_tokens: number | null;
  max_wall_duration_ms: number | null;
  outcome_criteria_json: string | null;
  resources_json: string | null;
  vault_ids_json: string | null;
  parent_session_id: string | null;
  thread_depth: number;
  /** User profile scoping. Null = no profile attached. */
  user_profile_id: string | null;
  /** v0.4+: API key that authenticated the session creation. Null for pre-0.4 rows. */
  api_key_id: string | null;
  /** v0.5: tenant ownership. Null = legacy/global (pre-migration). */
  tenant_id: string | null;
  /**
   * 0.5.45: debug-prompt capture. Null = disabled. Sentinel
   * `{"pending":true}` = enabled, no turn yet. JSON payload = captured.
   */
  debug_prompt_json: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface SessionResource {
  type: "uri" | "text" | "file" | "github_repository" | "memory_store";
  uri?: string;
  content?: string;
  file_id?: string;
  mount_path?: string;
  /** Internal field name for clone URL */
  repository_url?: string;
  /** Anthropic API field name for clone URL (fallback) */
  url?: string;
  branch?: string;
  commit?: string;
  /** Memory store resource fields */
  memory_store_id?: string;
  access?: "read_only" | "read_write";
  instructions?: string;
}

export interface OutcomeEvaluation {
  type: "outcome_evaluation";
  outcome_id: string;
  description: string;
  result: "pending" | "running" | "evaluating" | "satisfied" | "max_iterations_reached" | "failed" | "interrupted";
  iteration: number;
  completed_at: string | null;
  explanation: string;
}

export interface Session {
  id: string;
  type: "session";
  agent: {
    type: "agent";
    id: string;
    version: number;
    name: string;
    description: string;
    model: { id: string; speed?: "standard" | "fast" };
    system: string | null;
    tools: ToolConfig[];
    mcp_servers: Array<{ name: string; type: string; url?: string; [key: string]: unknown }>;
    skills: AgentSkill[];
  };
  environment_id: string;
  status: SessionStatus;
  stop_reason: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  max_budget_usd: number | null;
  max_tokens: number | null;
  max_wall_duration_ms: number | null;
  outcome: Record<string, unknown> | null;
  outcome_evaluations: OutcomeEvaluation[];
  resources: SessionResource[];
  vault_ids: string[];
  user_profile_id: string | null;
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
    cache_creation: {
      ephemeral_5m_input_tokens: number;
      ephemeral_1h_input_tokens: number;
    };
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
  agent_id: string | null;
  name: string;
  metadata_json: string;
  /** v0.5: tenant ownership. Null = legacy/global (pre-migration). */
  tenant_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface Vault {
  type: "vault";
  id: string;
  agent_id: string | null;
  name: string;
  /** Anthropic-compatible alias for `name`. */
  display_name: string;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
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
  expires_at: string | null;
  refresh_config_encrypted: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Public auth shape for static_bearer credentials (secrets stripped). */
export interface VaultCredentialAuthStaticBearer {
  type: "static_bearer";
  mcp_server_url: string | null;
}

/** Public auth shape for mcp_oauth credentials (secrets stripped). */
export interface VaultCredentialAuthMcpOauth {
  type: "mcp_oauth";
  mcp_server_url: string | null;
  expires_at: string | null;
}

export interface VaultCredential {
  type: "vault_credential";
  id: string;
  vault_id: string;
  display_name: string;
  auth: VaultCredentialAuthStaticBearer | VaultCredentialAuthMcpOauth;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
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
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryStore {
  id: string;
  name: string;
  description: string | null;
  agent_id: string | null;
  archived_at: string | null;
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
// Memory Versions
// ---------------------------------------------------------------------------

export interface MemoryVersionRow {
  id: string;
  store_id: string;
  memory_id: string;
  operation: string;
  path: string;
  content: string | null;
  content_sha256: string | null;
  session_id: string | null;
  redacted_at: number | null;
  created_at: number;
}

export interface MemoryVersion {
  type: "memory_version";
  id: string;
  memory_store_id: string;
  memory_id: string;
  path: string;
  operation: "create" | "update" | "delete";
  content?: string;
  content_sha256?: string;
  session_id?: string;
  redacted_at?: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Skills (standalone, DB-stored)
// ---------------------------------------------------------------------------

/**
 * Skill — aligned with Anthropic Claude Skills API shape (currently
 * beta-gated by header `anthropic-beta: skills-2025-10-02`). Includes
 * aliases over our internal column names so callers using the official
 * Anthropic SDK see the field names they expect:
 *
 *   `display_title`  ↔ `name`            (Anthropic uses display_title)
 *   `latest_version` ↔ `current_version`
 *   `source`                                constant "custom" — Anthropic
 *                                           also returns "anthropic" for
 *                                           their pre-built skills.
 *
 * The Anthropic-canonical fields are listed first; AgentStep aliases
 * (`type`, `name`, `description`, `current_version`, `updated_at`,
 * `archived_at`) follow and will be removed in a future release once
 * callers have migrated.
 */
export interface Skill {
  // ─── Anthropic CMA-compat fields ─────────────────────────────────
  id: string;
  display_title: string;
  source: "custom" | "anthropic";
  latest_version: string;
  created_at: string;
  // ─── AgentStep aliases / extension fields ────────────────────────
  /** AgentStep convention; Anthropic responses omit this. */
  type: "skill";
  /** @deprecated alias for `display_title` — will be removed in a future release */
  name: string;
  /** AgentStep extension: free-form description. Not part of Anthropic CMA. */
  description: string;
  /** @deprecated alias for `latest_version` — will be removed in a future release */
  current_version: string;
  /** AgentStep extension: last-modified timestamp. */
  updated_at: string;
  /** AgentStep extension: archive marker. */
  archived_at: string | null;
}

export interface SkillVersion {
  type: "skill_version";
  id: string;
  skill_id: string;
  version: string;
  content: string;
  /** All files in the skill directory (relative path → content). Binary files use "base64:" prefix. */
  files?: Record<string, string>;
  created_at: string;
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
  /**
   * Tenant id from the `x-agentstep-tenant` header, validated. Null if absent.
   * Honored only when the key is a global admin (so the global-admin "system"
   * key can act on behalf of a specific tenant) or when the scoped key's
   * own `tenantId` matches the header (defensive — same value, accepted).
   * A scoped key with a mismatched header is rejected at auth time.
   *
   * Use `effectiveTenant(auth)` in scope helpers — do not read this directly.
   */
  actingAsTenant: string | null;
  /** Null = unlimited. In USD. Enforced in the driver pre-turn. */
  budgetUsd: number | null;
  /** Null = unlimited. Fixed 60-second window enforced in routeWrap. */
  rateLimitRpm: number | null;
  /** Running total of USD spent by this key. Updated transactionally alongside session usage. */
  spentUsd: number;
  /**
   * Auth mode. "gateway" is a gateway-issued key with full
   * tenant/scope/budget enforcement. "passthrough" is a client-supplied
   * Anthropic key (sk-ant-api*) — gateway acts as a transparent proxy
   * with no DB writes; routeWrap forwards the request directly. Only
   * allowed on Anthropic-compatible routes (see auth/passthrough.ts).
   *
   * Required (not optional) so any new AuthContext constructor must
   * make a deliberate choice — drift would otherwise let a passthrough
   * key fall through to a tenant-scoped handler.
   */
  mode: "gateway" | "passthrough";
  /** The raw upstream key when mode === "passthrough". Never logged. */
  passthroughKey?: string;
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

// ---------------------------------------------------------------------------
// Session Threads (Multi-Agent)
// ---------------------------------------------------------------------------

export type SessionThreadStatus = "idle" | "running" | "terminated";

export interface SessionThreadRow {
  id: string;
  session_id: string;
  agent_id: string;
  agent_version: number;
  parent_thread_id: string | null;
  status: SessionThreadStatus;
  stop_reason: string | null;
  usage_input_tokens: number;
  usage_output_tokens: number;
  usage_cache_read_input_tokens: number;
  usage_cache_creation_input_tokens: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface SessionThread {
  type: "session_thread";
  id: string;
  session_id: string;
  status: SessionThreadStatus;
  agent: {
    type: "agent";
    id: string;
    version: number;
    name: string;
    description: string;
    model: { id: string; speed?: string };
    system: string | null;
    tools: ToolConfig[];
    mcp_servers: Array<{ name: string; type: string; url?: string; [key: string]: unknown }>;
    skills: AgentSkill[];
  };
  parent_thread_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation: {
      ephemeral_5m_input_tokens: number;
      ephemeral_1h_input_tokens: number;
    };
  };
  stop_reason: string | null;
}
