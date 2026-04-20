/**
 * Zod schemas for the Managed Agents API surface.
 *
 * These are the source of truth for the OpenAPI document generated at
 * `GET /v1/openapi.json`. Mirror `lib/types.ts` resource shapes exactly and
 * mirror the inline request-body schemas currently defined in each route
 * handler.
 *
 * All schemas registered via `registry.register(...)` become named `$ref`
 * entries in the OpenAPI `components.schemas` section. Inline object
 * schemas are embedded directly under the operation.
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry";

// Augment Zod with .openapi() metadata chainables. Must run before any
// schema is registered.
extendZodWithOpenApi(z);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const UlidId = z.string().openapi({ example: "agent_01J0ABCDE..." });
const IsoTimestamp = z.string().datetime().openapi({ example: "2026-04-09T11:30:00.000Z" });

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export const ErrorEnvelopeSchema = registry.register(
  "Error",
  z
    .object({
      type: z.literal("error"),
      error: z.object({
        type: z.enum([
          "invalid_request_error",
          "authentication_error",
          "permission_error",
          "not_found_error",
          "rate_limit_error",
          "server_busy",
          "server_error",
        ]),
        message: z.string(),
      }),
    })
    .openapi({
      description:
        "Error envelope returned from every `/v1/*` endpoint on failure. Status code is reflected by the `error.type` field.",
    }),
);

// ---------------------------------------------------------------------------
// Tool config (agent_toolset / custom)
// ---------------------------------------------------------------------------

const AgentToolsetTool = z
  .object({
    type: z.literal("agent_toolset_20260401"),
    configs: z
      .array(z.object({ name: z.string(), enabled: z.boolean().optional() }))
      .optional(),
    default_config: z.object({ enabled: z.boolean().optional() }).optional(),
  })
  .openapi({
    description:
      "Enables claude's built-in tool surface. Use `configs[]` to toggle individual tools and `default_config.enabled=false` to invert the default (start empty and whitelist).",
  });

const CustomTool = z
  .object({
    type: z.literal("custom"),
    name: z.string().min(1),
    description: z.string(),
    input_schema: z.record(z.unknown()),
  })
  .openapi({
    description:
      "Custom tool defined by the client. v1 accepts these in the agent record but does not yet bridge them to claude's tool-use loop — clients that can drive tool_use events directly can round-trip them via the user.custom_tool_result event.",
  });

export const ToolConfigSchema = registry.register(
  "ToolConfig",
  z.union([AgentToolsetTool, CustomTool]),
);

// ---------------------------------------------------------------------------
// MCP server config
// ---------------------------------------------------------------------------

export const McpServerConfigSchema = registry.register(
  "McpServerConfig",
  z.object({
    type: z.enum(["stdio", "http", "sse"]).optional(),
    url: z.string().optional(),
    command: z.union([z.string(), z.array(z.string())]).optional(),
    args: z.array(z.string()).optional(),
    headers: z.record(z.string()).optional(),
    env: z.record(z.string()).optional(),
  }),
);

// ---------------------------------------------------------------------------
// Agent Skill
// ---------------------------------------------------------------------------

export const AgentSkillSchema = registry.register(
  "AgentSkill",
  z.object({
    name: z.string().openapi({ description: "Unique skill name used as directory name." }),
    source: z.string().openapi({ description: "Source identifier for the skill (e.g. a registry URL or package name)." }),
    content: z.string().openapi({ description: "Markdown content of the skill, written as SKILL.md into the container." }),
    installed_at: z.string().openapi({ description: "ISO timestamp when the skill was installed." }),
  }),
);

// ---------------------------------------------------------------------------
// ModelConfig
// ---------------------------------------------------------------------------

export const ModelConfigSchema = registry.register(
  "ModelConfig",
  z.object({
    speed: z.enum(["standard", "fast"]).optional().openapi({
      description: "Model speed. 'fast' enables fast mode on Claude. Only affects claude engine.",
    }),
  }),
);

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const AgentSchema = registry.register(
  "Agent",
  z.object({
    id: UlidId,
    version: z.number().int().positive(),
    name: z.string(),
    model: z.string(),
    system: z.string().nullable(),
    tools: z.array(ToolConfigSchema),
    mcp_servers: z.record(McpServerConfigSchema),
    engine: z.enum(["claude", "opencode", "codex", "anthropic", "gemini", "factory", "pi"]).openapi({
      description:
        "Which agent harness powers this agent. `claude` drives `claude -p`; `opencode` drives sst/opencode-ai's `opencode run`; `gemini` drives Google's `gemini -p`; `factory` drives Factory's `droid exec`; `pi` drives the pi.dev coding agent (`pi --mode json`). Immutable after agent creation.",
    }),
    webhook_url: z.string().nullable().openapi({
      description: "URL to POST webhook notifications to. Best-effort delivery with 5s timeout.",
    }),
    webhook_events: z.array(z.string()).openapi({
      description: "Event types that trigger webhook delivery. Defaults to status + error events.",
    }),
    threads_enabled: z.boolean().openapi({
      description: "Whether this agent can spawn sub-agents via the spawn_agent tool.",
    }),
    confirmation_mode: z.boolean().openapi({
      description: "Whether this agent requires tool confirmation via user.tool_confirmation events. When true, claude runs with --permission-mode default and a PermissionRequest hook bridges tool approvals to the MA API.",
    }),
    skills: z.array(AgentSkillSchema).openapi({
      description: "Skills injected into the container at session start. For Claude backend, written to .claude/skills/<name>/SKILL.md. For all backends, also written to .agents/skills/<name>/SKILL.md. Non-Claude backends also receive skills prepended to the system prompt.",
    }),
    model_config: ModelConfigSchema.openapi({
      description: "Model configuration options. 'fast' speed enables fast mode on Claude (claude engine only).",
    }),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  }),
);

export const CreateAgentRequestSchema = registry.register(
  "CreateAgentRequest",
  z
    .object({
      name: z.string().min(1).openapi({ example: "my-agent" }),
      model: z.string().min(1).openapi({ example: "claude-sonnet-4-6" }),
      system: z.string().nullish().openapi({ example: "You are a helpful assistant." }),
      tools: z.array(ToolConfigSchema).optional(),
      mcp_servers: z.record(McpServerConfigSchema).optional(),
      engine: z.enum(["claude", "opencode", "codex", "anthropic", "gemini", "factory", "pi"]).optional().openapi({
        description:
          "Agent harness. Defaults to `claude`. Opencode agents must set `model` to a `provider/model` string (e.g. `anthropic/claude-sonnet-4-6`) and must NOT declare `tools` — opencode manages its tool surface internally. Gemini agents require GEMINI_API_KEY. Factory agents require FACTORY_API_KEY. Pi agents (pi.dev) require at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.",
        example: "claude",
      }),
      webhook_url: z.string().url().optional().openapi({
        description: "URL to POST webhook notifications to.",
      }),
      webhook_events: z.array(z.string()).optional().openapi({
        description: "Event types to deliver via webhook. Defaults to [\"session.status_idle\",\"session.status_running\",\"session.error\"].",
      }),
      threads_enabled: z.boolean().optional().openapi({
        description: "Enable multi-agent threads. When true, spawn_agent tool is available.",
      }),
      confirmation_mode: z.boolean().optional().openapi({
        description: "Enable tool confirmation mode. When true, claude requires explicit user approval for tool calls via user.tool_confirmation events.",
      }),
      skills: z.array(AgentSkillSchema).max(20).optional().openapi({
        description: "Skills to inject into the container at session start. Maximum 20 skills, 256KB per skill, 1MB total. For Claude: written to .claude/skills/<name>/SKILL.md. All backends: also written to .agents/skills/<name>/SKILL.md.",
      }),
      model_config: ModelConfigSchema.optional().openapi({
        description: "Model configuration options. 'fast' speed enables fast mode on Claude (claude engine only).",
      }),
    })
    .openapi({
      example: {
        name: "my-agent",
        model: "claude-sonnet-4-6",
        system: "You are a helpful assistant.",
        tools: [{ type: "agent_toolset_20260401" }],
      },
    }),
);

export const UpdateAgentRequestSchema = registry.register(
  "UpdateAgentRequest",
  z.object({
    name: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    system: z.string().nullish(),
    tools: z.array(ToolConfigSchema).optional(),
    mcp_servers: z.record(McpServerConfigSchema).optional(),
    skills: z.array(AgentSkillSchema).max(20).optional().openapi({
      description: "Updated skills list. Replaces the existing skills entirely.",
    }),
    model_config: ModelConfigSchema.optional().openapi({
      description: "Model configuration options. 'fast' speed enables fast mode on Claude (claude engine only).",
    }),
  }),
);

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const EnvironmentPackages = z
  .object({
    apt: z.array(z.string()).optional(),
    cargo: z.array(z.string()).optional(),
    gem: z.array(z.string()).optional(),
    go: z.array(z.string()).optional(),
    npm: z.array(z.string()).optional(),
    pip: z.array(z.string()).optional(),
  })
  .openapi({
    description:
      "Package lists installed into the sprite during environment setup. All are optional.",
  });

const EnvironmentNetworking = z.union([
  z.object({ type: z.literal("unrestricted") }),
  z.object({
    type: z.literal("limited"),
    allowed_hosts: z.array(z.string()).optional(),
    allow_mcp_servers: z.boolean().optional(),
    allow_package_managers: z.boolean().optional(),
  }),
]);

export const EnvironmentConfigSchema = registry.register(
  "EnvironmentConfig",
  z.object({
    type: z.literal("cloud"),
    provider: z.enum(["sprites", "docker", "apple-container", "apple-firecracker", "podman", "e2b", "vercel", "daytona", "fly", "modal", "mvm"]).optional().openapi({
      description:
        "Container provider for this environment. `sprites` uses sprites.dev cloud containers (default); `docker` uses local Docker containers; `apple-container` uses Apple Containers on macOS 26+ (Apple Silicon only); `apple-firecracker` uses AgentStep Firecracker microVMs (macOS, M3+ Apple Silicon); `podman` uses Podman containers; `e2b` uses E2B cloud sandboxes; `vercel` uses Vercel Sandboxes; `daytona` uses Daytona workspaces; `fly` uses Fly.io Machines; `modal` uses Modal sandboxes.",
    }),
    packages: EnvironmentPackages.optional(),
    networking: EnvironmentNetworking.optional(),
  }),
);

export const EnvironmentSchema = registry.register(
  "Environment",
  z.object({
    id: UlidId,
    name: z.string(),
    description: z.string().nullable().openapi({
      description: "Optional human-readable description of the environment.",
    }),
    config: EnvironmentConfigSchema,
    metadata: z.record(z.string()).openapi({
      description: "Key-value metadata attached to the environment. Values must be strings.",
    }),
    state: z.enum(["preparing", "ready", "failed"]),
    state_message: z.string().nullable(),
    created_at: IsoTimestamp,
    archived_at: IsoTimestamp.nullable(),
  }),
);

export const CreateEnvironmentRequestSchema = registry.register(
  "CreateEnvironmentRequest",
  z
    .object({
      name: z.string().min(1).openapi({ example: "my-env" }),
      config: EnvironmentConfigSchema,
      description: z.string().optional().nullable().openapi({
        description: "Optional human-readable description of the environment.",
      }),
      metadata: z.record(z.string()).optional().openapi({
        description: "Key-value metadata to attach to the environment. Values must be strings.",
      }),
    })
    .openapi({
      example: {
        name: "my-env",
        config: { type: "cloud", networking: { type: "unrestricted" } },
      },
    }),
);

export const UpdateEnvironmentRequestSchema = registry.register(
  "UpdateEnvironmentRequest",
  z.object({
    name: z.string().min(1).optional().openapi({ example: "my-env-renamed" }),
    description: z.string().optional().nullable().openapi({
      description: "Update the description. Pass null to clear.",
    }),
    metadata: z.record(z.string()).optional().openapi({
      description: "Replaces the metadata entirely. Values must be strings.",
    }),
    config: EnvironmentConfigSchema.optional(),
  }),
);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const SessionStatsSchema = z.object({
  turn_count: z.number().int().nonnegative(),
  tool_calls_count: z.number().int().nonnegative(),
  active_seconds: z.number().nonnegative(),
  duration_seconds: z.number().nonnegative(),
});

const SessionUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
});

export const SessionStatusSchema = registry.register(
  "SessionStatus",
  z.enum(["idle", "running", "rescheduling", "terminated"]),
);

export const SessionSchema = registry.register(
  "Session",
  z.object({
    id: UlidId,
    agent: z.object({ id: UlidId, version: z.number().int().positive() }),
    environment_id: UlidId,
    status: SessionStatusSchema,
    stop_reason: z.union([
      z.object({
        type: z.string().openapi({ description: "Stop reason type, e.g. 'end_turn', 'error', 'interrupted', 'requires_action'." }),
        event_ids: z.array(z.string()).optional().openapi({ description: "Event IDs associated with this stop reason (e.g. custom_tool_use events for requires_action)." }),
      }),
      z.null(),
    ]).openapi({ description: "Structured stop reason for the session's last turn, or null if no turn has completed." }),
    title: z.string().nullable(),
    metadata: z.record(z.unknown()),
    max_budget_usd: z.number().nullable().openapi({
      description: "Maximum spend for this session in USD. Turn start is rejected once cumulative usage_cost_usd reaches this cap.",
    }),
    outcome: z.record(z.unknown()).nullable().openapi({
      description: "Outcome criteria set via user.define_outcome event.",
    }),
    resources: z.array(z.object({
      type: z.enum(["uri", "text"]),
      uri: z.string().optional(),
      content: z.string().optional(),
    })).nullable().openapi({
      description: "Resources attached to the session, downloaded into the container at /tmp/resources/.",
    }),
    vault_ids: z.array(z.string()).nullable().openapi({
      description: "Vault IDs whose entries are injected as environment variables.",
    }),
    parent_session_id: z.string().nullable().openapi({
      description: "Parent session ID if this is a child thread session.",
    }),
    thread_depth: z.number().int().nonnegative().openapi({
      description: "Thread nesting depth. 0 for top-level sessions.",
    }),
    stats: SessionStatsSchema,
    usage: SessionUsageSchema,
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
    archived_at: IsoTimestamp.nullable(),
  }),
);

export const CreateSessionRequestSchema = registry.register(
  "CreateSessionRequest",
  z
    .object({
      agent: z.union([
        UlidId,
        z.object({
          id: UlidId,
          version: z.number().int(),
          type: z.literal("agent").optional(),
        }),
      ]),
      environment_id: UlidId,
      title: z.string().nullish(),
      metadata: z.record(z.unknown()).optional(),
      max_budget_usd: z.number().positive().optional().openapi({
        description: "Maximum spend for this session in USD. Once exceeded, turns are rejected with a budget_exceeded error.",
      }),
      resources: z.array(z.object({
        type: z.enum(["uri", "text"]),
        uri: z.string().optional(),
        content: z.string().optional(),
      })).optional(),
      vault_ids: z.array(z.string()).optional(),
    })
    .openapi({
      example: {
        agent: "agent_01ABCDEFG...",
        environment_id: "env_01ABCDEFG...",
      },
    }),
);

export const UpdateSessionRequestSchema = registry.register(
  "UpdateSessionRequest",
  z.object({
    title: z.string().nullish(),
    metadata: z.record(z.unknown()).optional(),
    vault_ids: z.array(z.string()).optional(),
  }),
);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const TextBlock = z.object({ type: z.literal("text"), text: z.string() });

const UserMessageEvent = z
  .object({
    type: z.literal("user.message"),
    content: z.array(TextBlock).min(1),
  })
  .openapi({
    description: "Append a user message to the session. Triggers a new turn.",
  });

const UserInterruptEvent = z
  .object({
    type: z.literal("user.interrupt"),
  })
  .openapi({
    description:
      "Interrupt the currently-running turn. No-op if session is idle. Mid-batch follow-up user.message events are executed after the interrupt.",
  });

const UserCustomToolResultEvent = z
  .object({
    type: z.literal("user.custom_tool_result"),
    custom_tool_use_id: z.string(),
    content: z.array(z.unknown()),
  })
  .openapi({
    description:
      "Client-provided result for a custom tool call. Only meaningful after an agent.custom_tool_use event with matching id.",
  });

const UserToolConfirmationEvent = z
  .object({
    type: z.literal("user.tool_confirmation"),
    tool_use_id: z.string().optional().openapi({
      description: "ID of the tool use to confirm. Optional — if omitted, applies to the current pending confirmation.",
    }),
    result: z.enum(["allow", "deny"]).optional().openapi({
      description: "Whether to allow or deny the tool use. Defaults to 'allow'.",
    }),
    deny_message: z.string().optional().openapi({
      description: "Optional message explaining why the tool use was denied.",
    }),
  })
  .openapi({
    description:
      "Confirm or deny a pending tool use. Only meaningful for agents with confirmation_mode enabled, after an agent.tool_confirmation_request event.",
  });

const UserDefineOutcomeEvent = z
  .object({
    type: z.literal("user.define_outcome"),
    description: z.string().min(1).openapi({
      description: "Description of the desired outcome for the agent to achieve.",
    }),
    rubric: z.string().optional().openapi({
      description: "Markdown rubric used by the grader to evaluate the agent's output.",
    }),
    max_iterations: z.number().int().min(1).max(20).optional().openapi({
      description: "Maximum grading iterations before giving up. Defaults to 3.",
    }),
  })
  .openapi({
    description:
      "Define an outcome for the agent to work toward. A grader evaluates the agent's output against the rubric after each turn, cycling until satisfied or max_iterations reached.",
  });

export const UserEventSchema = registry.register(
  "UserEvent",
  z.union([UserMessageEvent, UserInterruptEvent, UserCustomToolResultEvent, UserToolConfirmationEvent, UserDefineOutcomeEvent]),
);

export const UserEventBatchRequestSchema = registry.register(
  "UserEventBatchRequest",
  z
    .object({
      events: z.array(UserEventSchema).min(1),
    })
    .openapi({
      example: {
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      },
    }),
);

export const ManagedEventSchema = registry.register(
  "ManagedEvent",
  z
    .object({
      id: UlidId,
      seq: z.number().int().positive(),
      session_id: UlidId,
      type: z.string(),
      processed_at: IsoTimestamp.nullable(),
    })
    .catchall(z.unknown())
    .openapi({
      description:
        "Envelope for any Managed Agents event. Event-specific fields are mixed into the top level alongside id/seq/type — refer to the managed-agents-2026-04-01 spec for per-type shapes.",
    }),
);

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export const VaultSchema = registry.register(
  "Vault",
  z.object({
    id: UlidId,
    agent_id: UlidId,
    name: z.string(),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  }),
);

export const VaultEntrySchema = registry.register(
  "VaultEntry",
  z.object({
    key: z.string(),
    value: z.string(),
  }),
);

export const CreateVaultRequestSchema = registry.register(
  "CreateVaultRequest",
  z.object({
    agent_id: UlidId.openapi({ example: "agent_01ABCDEFG..." }),
    name: z.string().min(1).openapi({ example: "my-vault" }),
  }),
);

export const SetVaultEntryRequestSchema = registry.register(
  "SetVaultEntryRequest",
  z.object({
    value: z.string().openapi({ example: "some value" }),
  }),
);

export const VaultDeletedResponseSchema = registry.register(
  "VaultDeletedResponse",
  z.object({ id: UlidId, type: z.literal("vault_deleted") }),
);

export const VaultEntryDeletedResponseSchema = registry.register(
  "VaultEntryDeletedResponse",
  z.object({ key: z.string(), type: z.literal("entry_deleted") }),
);

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

export const BatchOperationSchema = registry.register(
  "BatchOperation",
  z.object({
    method: z.string().openapi({ example: "POST" }),
    path: z.string().openapi({ example: "/v1/agents" }),
    body: z.record(z.unknown()).optional(),
  }),
);

export const BatchRequestSchema = registry.register(
  "BatchRequest",
  z.object({
    operations: z.array(z.object({
      method: z.string(),
      path: z.string(),
      body: z.record(z.unknown()).optional(),
    })).min(1).max(50),
  }),
);

export const BatchResultSchema = registry.register(
  "BatchResult",
  z.object({
    status: z.number().int(),
    body: z.unknown(),
  }),
);

export const BatchResponseSchema = registry.register(
  "BatchResponse",
  z.object({
    results: z.array(z.object({
      status: z.number().int(),
      body: z.unknown(),
    })),
  }),
);

// ---------------------------------------------------------------------------
// List envelopes
// ---------------------------------------------------------------------------

function listEnvelope<T extends z.ZodTypeAny>(
  name: string,
  item: T,
): z.ZodObject<{ data: z.ZodArray<T>; next_page: z.ZodNullable<z.ZodString> }> {
  const schema = z.object({
    data: z.array(item),
    next_page: z.string().nullable(),
  });
  return registry.register(name, schema) as unknown as typeof schema;
}

export const AgentListResponseSchema = listEnvelope("AgentListResponse", AgentSchema);
export const EnvironmentListResponseSchema = listEnvelope(
  "EnvironmentListResponse",
  EnvironmentSchema,
);
export const SessionListResponseSchema = listEnvelope("SessionListResponse", SessionSchema);
export const EventListResponseSchema = listEnvelope("EventListResponse", ManagedEventSchema);

// Vault list uses a simpler shape (no next_page cursor).
export const VaultListResponseSchema = registry.register(
  "VaultListResponse",
  z.object({ data: z.array(VaultSchema) }),
);

export const VaultEntryListResponseSchema = registry.register(
  "VaultEntryListResponse",
  z.object({ data: z.array(VaultEntrySchema) }),
);

// ---------------------------------------------------------------------------
// Delete responses
// ---------------------------------------------------------------------------

export const AgentDeletedResponseSchema = registry.register(
  "AgentDeletedResponse",
  z.object({ id: UlidId, type: z.literal("agent_deleted") }),
);

export const SessionDeletedResponseSchema = registry.register(
  "SessionDeletedResponse",
  z.object({ id: UlidId, type: z.literal("session_deleted") }),
);

export const EnvironmentDeletedResponseSchema = registry.register(
  "EnvironmentDeletedResponse",
  z.object({ id: UlidId, type: z.literal("environment_deleted") }),
);

// ---------------------------------------------------------------------------
// Event append response
// ---------------------------------------------------------------------------

export const UserEventAppendResponseSchema = registry.register(
  "UserEventAppendResponse",
  z.object({ data: z.array(ManagedEventSchema) }),
);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const FileScopeSchema = z.object({
  type: z.enum(["session"]).openapi({ description: "Scope type. Currently only 'session' is supported." }),
  id: z.string().openapi({ description: "ID of the owning session." }),
});

export const FileRecordSchema = registry.register(
  "FileRecord",
  z.object({
    id: UlidId,
    filename: z.string(),
    size: z.number().int().nonnegative(),
    content_type: z.string(),
    scope: FileScopeSchema.nullable().openapi({
      description: "Scope the file is attached to. Null for legacy unscoped files (global-admin only).",
    }),
    created_at: IsoTimestamp,
  }),
);

export const FileListResponseSchema = registry.register(
  "FileListResponse",
  z.object({ data: z.array(FileRecordSchema) }),
);

export const FileDeletedResponseSchema = registry.register(
  "FileDeletedResponse",
  z.object({ id: UlidId, type: z.literal("file_deleted") }),
);

// ---------------------------------------------------------------------------
// Vault Credentials
// ---------------------------------------------------------------------------

export const VaultCredentialSchema = registry.register(
  "VaultCredential",
  z.object({
    id: UlidId,
    vault_id: UlidId,
    display_name: z.string(),
    auth: z.object({
      type: z.string().openapi({ description: "Auth type, e.g. 'static_bearer'." }),
      mcp_server_url: z.string().nullable().openapi({ description: "Associated MCP server URL, if any." }),
    }),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  }).openapi({ description: "Vault credential metadata. The secret token is NEVER returned in API responses." }),
);

export const CreateCredentialRequestSchema = registry.register(
  "CreateCredentialRequest",
  z.object({
    display_name: z.string().min(1).max(200),
    auth: z.object({
      type: z.enum(["static_bearer"]),
      token: z.string().min(1).openapi({ description: "Secret token value. Stored encrypted; never returned." }),
      mcp_server_url: z.string().url().optional(),
    }),
  }),
);

export const UpdateCredentialRequestSchema = registry.register(
  "UpdateCredentialRequest",
  z.object({
    display_name: z.string().min(1).max(200).optional(),
    auth: z.object({
      type: z.enum(["static_bearer"]).optional(),
      token: z.string().min(1).optional(),
      mcp_server_url: z.string().url().nullish(),
    }).optional(),
  }),
);

export const CredentialListResponseSchema = registry.register(
  "CredentialListResponse",
  z.object({ data: z.array(VaultCredentialSchema) }),
);

export const CredentialDeletedResponseSchema = registry.register(
  "CredentialDeletedResponse",
  z.object({ id: UlidId, type: z.literal("credential_deleted") }),
);

// ---------------------------------------------------------------------------
// Memory Stores & Memories
// ---------------------------------------------------------------------------

export const MemoryStoreSchema = registry.register(
  "MemoryStore",
  z.object({
    id: UlidId,
    name: z.string(),
    description: z.string().nullable(),
    agent_id: z.string().nullable().openapi({ description: "Owning agent ID. Null for legacy global stores." }),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  }),
);

export const CreateMemoryStoreRequestSchema = registry.register(
  "CreateMemoryStoreRequest",
  z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    agent_id: z.string().min(1).openapi({ description: "Agent to attach this store to." }),
  }),
);

export const MemoryStoreListResponseSchema = registry.register(
  "MemoryStoreListResponse",
  z.object({ data: z.array(MemoryStoreSchema) }),
);

export const MemoryStoreDeletedResponseSchema = registry.register(
  "MemoryStoreDeletedResponse",
  z.object({ id: UlidId, type: z.literal("memory_store_deleted") }),
);

export const MemorySchema = registry.register(
  "Memory",
  z.object({
    id: UlidId,
    store_id: UlidId,
    path: z.string(),
    content: z.string(),
    content_sha256: z.string().openapi({ description: "SHA-256 hash of the content. Used for optimistic concurrency in PATCH." }),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  }),
);

export const CreateMemoryRequestSchema = registry.register(
  "CreateMemoryRequest",
  z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
);

export const UpdateMemoryRequestSchema = registry.register(
  "UpdateMemoryRequest",
  z.object({
    content: z.string(),
    content_sha256: z.string().optional().openapi({
      description: "Optimistic concurrency check. If provided and does not match the current hash, returns 409.",
    }),
  }),
);

export const MemoryListResponseSchema = registry.register(
  "MemoryListResponse",
  z.object({ data: z.array(MemorySchema) }),
);

export const MemoryDeletedResponseSchema = registry.register(
  "MemoryDeletedResponse",
  z.object({ id: UlidId, type: z.literal("memory_deleted") }),
);

// ---------------------------------------------------------------------------
// Session Resources
// ---------------------------------------------------------------------------

export const SessionResourceSchema = registry.register(
  "SessionResource",
  z.object({
    id: z.string().openapi({ description: "Resource index id, e.g. 'res_0'." }),
    type: z.enum(["uri", "text", "file", "github_repository"]),
    uri: z.string().optional(),
    content: z.string().optional(),
    file_id: z.string().optional(),
    mount_path: z.string().optional(),
    repository_url: z.string().optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    session_id: UlidId,
    created_at: IsoTimestamp.optional(),
  }),
);

export const AddResourceRequestSchema = registry.register(
  "AddResourceRequest",
  z.object({
    type: z.enum(["uri", "text", "file", "github_repository"]),
    uri: z.string().optional(),
    content: z.string().optional(),
    file_id: z.string().optional(),
    mount_path: z.string().optional(),
    repository_url: z.string().optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
  }),
);

export const ResourceListResponseSchema = registry.register(
  "ResourceListResponse",
  z.object({ data: z.array(SessionResourceSchema) }),
);

export const ResourceDeletedResponseSchema = registry.register(
  "ResourceDeletedResponse",
  z.object({ id: z.string(), type: z.literal("session_resource_deleted") }),
);

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------

const KeyScopeSchema = z.object({
  agents: z.array(z.string()),
  environments: z.array(z.string()),
  vaults: z.array(z.string()),
});

const KeyPermissionsSchema = z.object({
  admin: z.boolean().openapi({ description: "Whether this key has admin privileges." }),
  scope: KeyScopeSchema.nullable().openapi({ description: "Resource scope restrictions. Null = unrestricted within tenancy." }),
});

export const ApiKeySchema = registry.register(
  "ApiKey",
  z.object({
    id: UlidId,
    name: z.string(),
    prefix: z.string().openapi({ description: "First characters of the key, for identification." }),
    permissions: KeyPermissionsSchema,
    tenant_id: z.string().nullable(),
    created_at: z.number().openapi({ description: "Unix timestamp in milliseconds." }),
  }),
);

export const ApiKeyCreatedSchema = registry.register(
  "ApiKeyCreated",
  z.object({
    id: UlidId,
    name: z.string(),
    key: z.string().openapi({ description: "The full API key. Returned ONCE at creation time — store it securely." }),
    permissions: KeyPermissionsSchema,
    tenant_id: z.string().nullable(),
  }),
);

export const CreateApiKeyRequestSchema = registry.register(
  "CreateApiKeyRequest",
  z.object({
    name: z.string().min(1).max(200),
    permissions: KeyPermissionsSchema.optional(),
    tenant_id: z.string().optional(),
  }),
);

export const PatchApiKeyRequestSchema = registry.register(
  "PatchApiKeyRequest",
  z.object({
    permissions: KeyPermissionsSchema,
  }),
);

export const ApiKeyListResponseSchema = registry.register(
  "ApiKeyListResponse",
  z.object({ data: z.array(ApiKeySchema) }),
);

export const ApiKeyRevokedResponseSchema = registry.register(
  "ApiKeyRevokedResponse",
  z.object({ ok: z.literal(true), id: UlidId }),
);

export const ApiKeyActivityResponseSchema = registry.register(
  "ApiKeyActivityResponse",
  z.object({
    id: UlidId,
    name: z.string(),
    sessions: z.array(SessionSchema),
    totals: z.object({
      session_count: z.number().int().nonnegative(),
      cost_usd: z.number().nonnegative(),
      turn_count: z.number().int().nonnegative(),
      error_count: z.number().int().nonnegative(),
    }),
  }),
);

// ---------------------------------------------------------------------------
// Upstream Keys
// ---------------------------------------------------------------------------

export const UpstreamKeySchema = registry.register(
  "UpstreamKey",
  z.object({
    id: UlidId,
    provider: z.string().openapi({ description: "Provider name, e.g. 'anthropic', 'openai', 'gemini'." }),
    prefix: z.string().openapi({ description: "First 10 characters of the key, for identification." }),
    weight: z.number().int().positive(),
    disabled_at: z.number().nullable().openapi({ description: "Unix ms timestamp when key was disabled, or null if active." }),
    last_used_at: z.number().nullable().openapi({ description: "Unix ms timestamp of last use." }),
    created_at: z.number().openapi({ description: "Unix ms timestamp." }),
  }),
);

export const AddUpstreamKeyRequestSchema = registry.register(
  "AddUpstreamKeyRequest",
  z.object({
    provider: z.enum(["anthropic", "openai", "gemini"]),
    value: z.string().min(20).max(500).openapi({ description: "The raw API key value. Stored encrypted; never returned." }),
    weight: z.number().int().positive().optional(),
  }),
);

export const PatchUpstreamKeyRequestSchema = registry.register(
  "PatchUpstreamKeyRequest",
  z.object({
    disabled: z.boolean().openapi({ description: "Set to true to disable, false to re-enable." }),
  }),
);

export const UpstreamKeyListResponseSchema = registry.register(
  "UpstreamKeyListResponse",
  z.object({ data: z.array(UpstreamKeySchema) }),
);

export const UpstreamKeyDeletedResponseSchema = registry.register(
  "UpstreamKeyDeletedResponse",
  z.object({ ok: z.literal(true), id: UlidId }),
);

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

export const TenantSchema = registry.register(
  "Tenant",
  z.object({
    id: z.string().openapi({ example: "tenant_default" }),
    name: z.string(),
    created_at: IsoTimestamp,
    archived_at: IsoTimestamp.nullable(),
  }),
);

export const CreateTenantRequestSchema = registry.register(
  "CreateTenantRequest",
  z.object({
    name: z.string().min(1).max(200),
    id: z.string().regex(/^tenant_[a-z0-9_-]+$/i).optional().openapi({
      description: "Custom tenant ID. Must start with 'tenant_'. Auto-generated if omitted.",
    }),
  }),
);

export const PatchTenantRequestSchema = registry.register(
  "PatchTenantRequest",
  z.object({
    name: z.string().min(1).max(200).optional(),
  }),
);

export const TenantListResponseSchema = registry.register(
  "TenantListResponse",
  z.object({ data: z.array(TenantSchema) }),
);

export const TenantArchivedResponseSchema = registry.register(
  "TenantArchivedResponse",
  z.object({ ok: z.literal(true), id: z.string() }),
);

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------

export const AuditEntrySchema = registry.register(
  "AuditEntry",
  z.object({
    id: UlidId,
    created_at: IsoTimestamp,
    actor_key_id: z.string().nullable().openapi({ description: "API key ID of the actor, or null for system-initiated." }),
    actor_name: z.string().nullable().openapi({ description: "Friendly name of the actor at log time." }),
    tenant_id: z.string().nullable(),
    action: z.string().openapi({ description: "Dotted verb, e.g. 'tenants.create', 'api_keys.revoke'." }),
    resource_type: z.string().nullable().openapi({ description: "Resource type: 'agent', 'tenant', 'api_key', 'upstream_key', etc." }),
    resource_id: z.string().nullable(),
    outcome: z.enum(["success", "denied", "failure"]),
    metadata: z.record(z.unknown()).nullable().openapi({ description: "Action-specific context." }),
  }),
);

export const AuditListResponseSchema = registry.register(
  "AuditListResponse",
  z.object({
    data: z.array(AuditEntrySchema),
    next_page: z.string().nullable(),
  }),
);

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

export const TraceListItemSchema = registry.register(
  "TraceListItem",
  z.object({
    trace_id: z.string(),
    start_ms: z.number(),
    end_ms: z.number(),
    duration_ms: z.number().nonnegative(),
    event_count: z.number().int().nonnegative(),
    session_count: z.number().int().nonnegative(),
    first_session_id: z.string(),
  }),
);

export const TraceListResponseSchema = registry.register(
  "TraceListResponse",
  z.object({ data: z.array(TraceListItemSchema) }),
);

const SpanNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    span_id: z.string(),
    parent_span_id: z.string().nullable(),
    session_id: z.string(),
    name: z.string(),
    start_ms: z.number(),
    end_ms: z.number().nullable(),
    duration_ms: z.number().nullable(),
    status: z.enum(["ok", "error", "interrupted", "unclosed"]),
    attributes: z.record(z.unknown()),
    children: z.array(SpanNodeSchema),
  }),
);

export const TraceDetailSchema = registry.register(
  "TraceDetail",
  z.object({
    trace_id: z.string(),
    span_count: z.number().int().nonnegative(),
    session_ids: z.array(z.string()),
    start_ms: z.number(),
    end_ms: z.number(),
    duration_ms: z.number().nonnegative(),
    turn_count: z.number().int().nonnegative(),
    tool_call_count: z.number().int().nonnegative(),
    error_count: z.number().int().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative(),
    cache_creation_input_tokens: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative(),
    spans: z.array(z.record(z.unknown())).openapi({ description: "Span tree with nested children." }),
    events: z.array(ManagedEventSchema),
  }),
);

export const TraceExportResponseSchema = registry.register(
  "TraceExportResponse",
  z.object({
    ok: z.boolean(),
  }).catchall(z.unknown()),
);

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const SkillsCatalogResponseSchema = registry.register(
  "SkillsCatalogResponse",
  z.object({
    skills: z.array(z.record(z.unknown())),
    total: z.number().int().nonnegative(),
  }),
);

export const SkillsSearchResponseSchema = registry.register(
  "SkillsSearchResponse",
  z.object({
    skills: z.array(z.record(z.unknown())),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  }),
);

export const SkillsStatsResponseSchema = registry.register(
  "SkillsStatsResponse",
  z.record(z.unknown()).openapi({ description: "Aggregated skill statistics." }),
);

export const SkillsSourcesResponseSchema = registry.register(
  "SkillsSourcesResponse",
  z.object({
    data: z.array(z.record(z.unknown())),
    total: z.number().int().nonnegative(),
  }),
);

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const MetricsTotalsSchema = z.object({
  session_count: z.number().int().nonnegative(),
  turn_count: z.number().int().nonnegative(),
  tool_call_count: z.number().int().nonnegative(),
  error_count: z.number().int().nonnegative(),
  active_seconds: z.number().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
});

export const MetricsResponseSchema = registry.register(
  "MetricsResponse",
  z.object({
    window: z.object({ from: z.number(), to: z.number() }),
    group_by: z.string(),
    totals: MetricsTotalsSchema,
    groups: z.array(MetricsTotalsSchema.extend({ key: z.string() })),
    stop_reasons: z.record(z.number()),
    tool_latency_p50_ms: z.number().nullable(),
    tool_latency_p95_ms: z.number().nullable(),
    tool_latency_p99_ms: z.number().nullable(),
    tool_call_sample_count: z.number().int().nonnegative(),
  }),
);

export const ApiMetricsResponseSchema = registry.register(
  "ApiMetricsResponse",
  z.object({
    window_ms: z.number(),
    window_minutes: z.number(),
    now_ms: z.number(),
    totals: z.object({
      count: z.number().int().nonnegative(),
      rps: z.number().nonnegative(),
      p50_ms: z.number().nullable(),
      p95_ms: z.number().nullable(),
      p99_ms: z.number().nullable(),
      status_2xx: z.number().int().nonnegative(),
      status_3xx: z.number().int().nonnegative(),
      status_4xx: z.number().int().nonnegative(),
      status_5xx: z.number().int().nonnegative(),
      error_rate: z.number().nonnegative(),
    }),
    routes: z.array(z.record(z.unknown())),
    timeline: z.array(z.record(z.unknown())),
  }),
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const PutSettingRequestSchema = registry.register(
  "PutSettingRequest",
  z.object({
    key: z.string().openapi({ description: "Setting key to update." }),
    value: z.string().openapi({ description: "New value for the setting." }),
  }),
);

export const SettingResponseSchema = registry.register(
  "SettingResponse",
  z.object({
    key: z.string(),
    value: z.string().nullable(),
    configured: z.boolean(),
    masked: z.boolean().optional().openapi({ description: "True when the value is a masked secret." }),
  }),
);

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const ProviderStatusResponseSchema = registry.register(
  "ProviderStatusResponse",
  z.object({
    data: z.record(z.object({
      available: z.boolean(),
      message: z.string().optional(),
    })).openapi({ description: "Per-provider availability status." }),
  }),
);

// ---------------------------------------------------------------------------
// Auth (Whoami + License)
// ---------------------------------------------------------------------------

export const WhoamiResponseSchema = registry.register(
  "WhoamiResponse",
  z.object({
    name: z.string(),
    tenant_id: z.string().nullable(),
    is_global_admin: z.boolean(),
    permissions: KeyPermissionsSchema,
  }),
);

export const LicenseResponseSchema = registry.register(
  "LicenseResponse",
  z.object({
    plan: z.enum(["community", "enterprise"]),
    features: z.array(z.string()),
    limits: z.object({
      maxKeys: z.number().int(),
      auditRetentionMs: z.number().int(),
    }).nullable().openapi({ description: "Community-tier limits. Null for enterprise." }),
  }),
);
