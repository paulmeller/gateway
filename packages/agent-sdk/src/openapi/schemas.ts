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
    engine: z.enum(["claude", "opencode", "codex", "anthropic", "gemini", "factory"]).openapi({
      description:
        "Which agent harness powers this agent. `claude` drives `claude -p`; `opencode` drives sst/opencode-ai's `opencode run`; `gemini` drives Google's `gemini -p`; `factory` drives Factory's `droid exec`. Immutable after agent creation.",
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
      engine: z.enum(["claude", "opencode", "codex", "anthropic", "gemini", "factory"]).optional().openapi({
        description:
          "Agent harness. Defaults to `claude`. Opencode agents must set `model` to a `provider/model` string (e.g. `anthropic/claude-sonnet-4-6`) and must NOT declare `tools` — opencode manages its tool surface internally. Gemini agents require GEMINI_API_KEY. Factory agents require FACTORY_API_KEY.",
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
    config: EnvironmentConfigSchema,
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
    })
    .openapi({
      example: {
        name: "my-env",
        config: { type: "cloud", networking: { type: "unrestricted" } },
      },
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
    stop_reason: z.string().nullable(),
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
  z.object({ events: z.array(ManagedEventSchema) }),
);
