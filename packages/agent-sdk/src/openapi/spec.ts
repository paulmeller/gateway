/**
 * Build the OpenAPI 3.1 document for the managed-agents Managed Agents API.
 *
 * Import `schemas` first (side-effect: it registers named schemas with the
 * singleton registry). Then register every route operation, then run the
 * generator.
 */
import { z } from "zod";
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry";
import {
  AgentSchema,
  AgentListResponseSchema,
  AgentDeletedResponseSchema,
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
  EnvironmentSchema,
  EnvironmentListResponseSchema,
  EnvironmentDeletedResponseSchema,
  CreateEnvironmentRequestSchema,
  SessionSchema,
  SessionStatusSchema,
  SessionListResponseSchema,
  SessionDeletedResponseSchema,
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  EventListResponseSchema,
  UserEventBatchRequestSchema,
  UserEventAppendResponseSchema,
  ErrorEnvelopeSchema,
  VaultSchema,
  VaultEntrySchema,
  VaultListResponseSchema,
  VaultEntryListResponseSchema,
  CreateVaultRequestSchema,
  SetVaultEntryRequestSchema,
  VaultDeletedResponseSchema,
  VaultEntryDeletedResponseSchema,
  BatchRequestSchema,
  BatchResponseSchema,
} from "./schemas";

// Security scheme: the Managed Agents spec uses `x-api-key` header auth
// (with optional `Authorization: Bearer` fallback — we document the primary).
registry.registerComponent("securitySchemes", "ApiKey", {
  type: "apiKey",
  in: "header",
  name: "x-api-key",
});

// Shared error responses — every authed route can emit these
const ErrorResponses = {
  400: { description: "Bad request", content: { "application/json": { schema: ErrorEnvelopeSchema } } },
  401: {
    description: "Missing or invalid API key",
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  },
  404: {
    description: "Resource not found",
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  },
  409: {
    description: "Conflict (e.g. environment has attached sessions)",
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  },
  500: {
    description: "Server error",
    content: { "application/json": { schema: ErrorEnvelopeSchema } },
  },
};

// ---------------------------------------------------------------------------
// /v1/agents
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/agents",
  tags: ["Agents"],
  summary: "Create an agent",
  security: [{ ApiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateAgentRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Agent created",
      content: { "application/json": { schema: AgentSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/agents",
  tags: ["Agents"],
  summary: "List agents",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      page: z.string().optional().describe("ULID cursor for pagination"),
      include_archived: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "A page of agents",
      content: { "application/json": { schema: AgentListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/agents/{id}",
  tags: ["Agents"],
  summary: "Retrieve an agent (optionally a specific version)",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({ version: z.coerce.number().int().optional() }),
  },
  responses: {
    200: {
      description: "Agent retrieved",
      content: { "application/json": { schema: AgentSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/agents/{id}",
  tags: ["Agents"],
  summary: "Update an agent (creates a new version)",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: UpdateAgentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Agent updated",
      content: { "application/json": { schema: AgentSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/agents/{id}",
  tags: ["Agents"],
  summary: "Archive an agent",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Agent archived",
      content: { "application/json": { schema: AgentDeletedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/environments
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/environments",
  tags: ["Environments"],
  summary: "Create an environment",
  description:
    "Returns immediately with `state: \"preparing\"`. Poll `GET /v1/environments/{id}` until `state` becomes `ready` before creating a session against it.",
  security: [{ ApiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateEnvironmentRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Environment created; async setup in progress",
      content: { "application/json": { schema: EnvironmentSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/environments",
  tags: ["Environments"],
  summary: "List environments",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      page: z.string().optional(),
      include_archived: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "A page of environments",
      content: { "application/json": { schema: EnvironmentListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/environments/{id}",
  tags: ["Environments"],
  summary: "Retrieve an environment",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Environment retrieved",
      content: { "application/json": { schema: EnvironmentSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/environments/{id}",
  tags: ["Environments"],
  summary: "Delete an environment",
  description:
    "Returns 409 if the environment has non-terminated sessions still attached.",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Environment deleted",
      content: { "application/json": { schema: EnvironmentDeletedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/environments/{id}/archive",
  tags: ["Environments"],
  summary: "Archive an environment",
  description:
    "Returns 409 if the environment has non-terminated sessions still attached (same guard as DELETE).",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Environment archived",
      content: { "application/json": { schema: EnvironmentSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/sessions
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/sessions",
  tags: ["Sessions"],
  summary: "Create a session",
  description:
    "Creates a session idle and pinned to the specified agent version + environment. A sprite is NOT allocated until the first user.message event.",
  security: [{ ApiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateSessionRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Session created",
      content: { "application/json": { schema: SessionSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/sessions",
  tags: ["Sessions"],
  summary: "List sessions",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      page: z.string().optional().describe("ULID cursor for pagination"),
      include_archived: z.enum(["true", "false"]).optional(),
      agent_id: z.string().optional(),
      agent_version: z.coerce.number().int().optional(),
      environment_id: z.string().optional(),
      status: SessionStatusSchema.optional(),
      "created_at[gt]": z.string().optional(),
      "created_at[gte]": z.string().optional(),
      "created_at[lt]": z.string().optional(),
      "created_at[lte]": z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "A page of sessions",
      content: { "application/json": { schema: SessionListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/sessions/{id}",
  tags: ["Sessions"],
  summary: "Retrieve a session",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Session retrieved",
      content: { "application/json": { schema: SessionSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/sessions/{id}",
  tags: ["Sessions"],
  summary: "Update session title / metadata",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: UpdateSessionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Session updated",
      content: { "application/json": { schema: SessionSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/sessions/{id}",
  tags: ["Sessions"],
  summary: "Delete (terminate) a session",
  description:
    "Interrupts any in-flight turn, releases the sprite, and flips the session to `terminated` with `stop_reason:\"deleted\"`.",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Session deleted",
      content: { "application/json": { schema: SessionDeletedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/sessions/{id}/archive",
  tags: ["Sessions"],
  summary: "Archive a session",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Session archived",
      content: { "application/json": { schema: SessionSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/sessions/{id}/events",
  tags: ["Events"],
  summary: "Append user events to a session",
  description:
    "Atomically appends a batch of user events. `user.message` events buffered while a turn is running are drained as a subsequent turn. Supports `user.message`, `user.interrupt`, `user.custom_tool_result`, `user.tool_confirmation` (requires confirmation_mode), and `user.define_outcome` (triggers grader loop).",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    headers: z.object({
      "idempotency-key": z
        .string()
        .optional()
        .describe("Per-event key is built as `<idempotency-key>:<batch index>`."),
    }),
    body: {
      required: true,
      content: { "application/json": { schema: UserEventBatchRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Events appended",
      content: { "application/json": { schema: UserEventAppendResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/sessions/{id}/events",
  tags: ["Events"],
  summary: "List a session's event history",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      after_seq: z.coerce.number().int().optional(),
    }),
  },
  responses: {
    200: {
      description: "A page of events",
      content: { "application/json": { schema: EventListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/sessions/{id}/stream",
  tags: ["Events"],
  summary: "Stream a session's events via Server-Sent Events",
  description:
    "Long-lived `text/event-stream` response. Each emitted event sets an `id:` field with the monotonic `seq`, so `EventSource` clients resume automatically via `Last-Event-ID`. A `data: {\"type\":\"ping\"}` keepalive is written every 15 seconds. On reconnect, the server backfills events with `seq > Last-Event-ID` from the DB before tailing live.",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    headers: z.object({
      "last-event-id": z
        .string()
        .optional()
        .describe("EventSource auto-populates this on reconnect; falls back to ?after_seq"),
    }),
    query: z.object({
      after_seq: z.coerce.number().int().optional(),
    }),
  },
  responses: {
    200: {
      description: "SSE stream opened",
      content: {
        "text/event-stream": {
          schema: z
            .string()
            .openapi({
              description:
                "Each frame is `id: <seq>\\nevent: <type>\\ndata: <json>\\n\\n`. JSON shape conforms to ManagedEvent.",
            }),
        },
      },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/vaults
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/vaults",
  tags: ["Vaults"],
  summary: "Create a vault",
  security: [{ ApiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateVaultRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Vault created",
      content: { "application/json": { schema: VaultSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/vaults",
  tags: ["Vaults"],
  summary: "List vaults",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      agent_id: z.string().optional().describe("Filter by agent ID"),
    }),
  },
  responses: {
    200: {
      description: "A list of vaults",
      content: { "application/json": { schema: VaultListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/vaults/{id}",
  tags: ["Vaults"],
  summary: "Retrieve a vault",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Vault retrieved",
      content: { "application/json": { schema: VaultSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/vaults/{id}",
  tags: ["Vaults"],
  summary: "Delete a vault and all its entries",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Vault deleted",
      content: { "application/json": { schema: VaultDeletedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/vaults/{id}/entries",
  tags: ["Vaults"],
  summary: "List vault entries",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "A list of vault entries",
      content: { "application/json": { schema: VaultEntryListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/vaults/{id}/entries/{key}",
  tags: ["Vaults"],
  summary: "Get a vault entry",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: {
    200: {
      description: "Vault entry retrieved",
      content: { "application/json": { schema: VaultEntrySchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "put",
  path: "/v1/vaults/{id}/entries/{key}",
  tags: ["Vaults"],
  summary: "Set a vault entry",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string(), key: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: SetVaultEntryRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Entry set",
      content: { "application/json": { schema: VaultEntrySchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/vaults/{id}/entries/{key}",
  tags: ["Vaults"],
  summary: "Delete a vault entry",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string(), key: z.string() }) },
  responses: {
    200: {
      description: "Entry deleted",
      content: { "application/json": { schema: VaultEntryDeletedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/batch
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/batch",
  tags: ["Batch"],
  summary: "Execute multiple operations atomically",
  description:
    "Wraps all operations in a single SQLite transaction. On any error, the transaction rolls back and the error is returned.",
  security: [{ ApiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: BatchRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "All operations succeeded",
      content: { "application/json": { schema: BatchResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// Generate the final document
// ---------------------------------------------------------------------------

export function buildOpenApiDocument(opts: { serverUrl: string }): unknown {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "AgentStep Gateway",
      version: "0.1.0",
      description:
        "Open-source, drop-in replacement for the Claude Managed Agents API. Self-hosted agent gateway with 6 agent harnesses and 9 sandbox providers. Use with `@agentstep/agent-sdk` or the official Anthropic SDK — just change the baseURL.",
    },
    servers: [{ url: opts.serverUrl, description: "This host" }],
    security: [{ ApiKey: [] }],
  });
}
