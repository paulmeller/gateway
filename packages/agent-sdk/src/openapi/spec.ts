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
  UpdateEnvironmentRequestSchema,
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
  // Files
  FileRecordSchema,
  FileListResponseSchema,
  FileDeletedResponseSchema,
  // Credentials
  VaultCredentialSchema,
  CreateCredentialRequestSchema,
  UpdateCredentialRequestSchema,
  CredentialListResponseSchema,
  CredentialDeletedResponseSchema,
  // Memory
  MemoryStoreSchema,
  CreateMemoryStoreRequestSchema,
  MemoryStoreListResponseSchema,
  MemoryStoreDeletedResponseSchema,
  MemorySchema,
  CreateMemoryRequestSchema,
  UpdateMemoryRequestSchema,
  MemoryListResponseSchema,
  MemoryDeletedResponseSchema,
  // Resources
  SessionResourceSchema,
  AddResourceRequestSchema,
  ResourceListResponseSchema,
  ResourceDeletedResponseSchema,
  // API Keys
  ApiKeySchema,
  ApiKeyCreatedSchema,
  CreateApiKeyRequestSchema,
  PatchApiKeyRequestSchema,
  ApiKeyListResponseSchema,
  ApiKeyRevokedResponseSchema,
  ApiKeyActivityResponseSchema,
  // Upstream Keys
  UpstreamKeySchema,
  AddUpstreamKeyRequestSchema,
  PatchUpstreamKeyRequestSchema,
  UpstreamKeyListResponseSchema,
  UpstreamKeyDeletedResponseSchema,
  // Tenants
  TenantSchema,
  CreateTenantRequestSchema,
  PatchTenantRequestSchema,
  TenantListResponseSchema,
  TenantArchivedResponseSchema,
  // Audit
  AuditListResponseSchema,
  // Traces
  TraceListResponseSchema,
  TraceDetailSchema,
  TraceExportResponseSchema,
  // Skills
  SkillsCatalogResponseSchema,
  SkillsSearchResponseSchema,
  SkillsStatsResponseSchema,
  SkillsSourcesResponseSchema,
  // Metrics
  MetricsResponseSchema,
  ApiMetricsResponseSchema,
  // Settings
  PutSettingRequestSchema,
  SettingResponseSchema,
  // Providers
  ProviderStatusResponseSchema,
  // Auth
  WhoamiResponseSchema,
  LicenseResponseSchema,
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
  method: "post",
  path: "/v1/environments/{id}",
  tags: ["Environments"],
  summary: "Update an environment",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: UpdateEnvironmentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Environment updated",
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

// ---------------------------------------------------------------------------
// /v1/sessions/{id}/events + /v1/sessions/{id}/events/stream
// ---------------------------------------------------------------------------

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
  path: "/v1/sessions/{id}/events/stream",
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
// /v1/sessions/{id}/threads
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/v1/sessions/{id}/threads",
  tags: ["Sessions"],
  summary: "List child thread sessions",
  description:
    "Returns sessions spawned as child threads of this session via the spawn_agent tool.",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Child thread sessions",
      content: { "application/json": { schema: SessionListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/sessions/{id}/resources
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/sessions/{id}/resources",
  tags: ["Resources"],
  summary: "Add a resource to a session",
  description:
    "Attaches a resource (URI, text, file, or GitHub repo) to a session. Resources are provisioned into the container at turn start.",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: AddResourceRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Resource added",
      content: { "application/json": { schema: SessionResourceSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/sessions/{id}/resources",
  tags: ["Resources"],
  summary: "List session resources",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Session resources",
      content: { "application/json": { schema: ResourceListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/sessions/{id}/resources/{rid}",
  tags: ["Resources"],
  summary: "Remove a resource from a session",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string(), rid: z.string() }) },
  responses: {
    200: {
      description: "Resource removed",
      content: { "application/json": { schema: ResourceDeletedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/files
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/files",
  tags: ["Files"],
  summary: "Upload a file",
  description:
    "Accepts multipart/form-data with a `file` field, or a raw body with the file content. Use `?scope_id=<session_id>` to scope to a session.",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      filename: z.string().optional().describe("Filename for raw body uploads."),
      scope_id: z.string().optional().describe("Session ID to scope the file to."),
      scope_type: z.string().optional().describe("Scope type. Defaults to 'session'."),
    }),
  },
  responses: {
    201: {
      description: "File uploaded",
      content: { "application/json": { schema: FileRecordSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/files",
  tags: ["Files"],
  summary: "List files",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
      scope_id: z.string().optional().describe("Session ID to filter by scope."),
    }),
  },
  responses: {
    200: {
      description: "List of file records",
      content: { "application/json": { schema: FileListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/files/{id}",
  tags: ["Files"],
  summary: "Get file metadata",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "File metadata",
      content: { "application/json": { schema: FileRecordSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/files/{id}/content",
  tags: ["Files"],
  summary: "Download file content",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "File content as binary stream",
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ description: "Raw file bytes." }),
        },
      },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/files/{id}",
  tags: ["Files"],
  summary: "Delete a file",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "File deleted",
      content: { "application/json": { schema: FileDeletedResponseSchema } },
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

// ---------------------------------------------------------------------------
// /v1/vaults/{id}/credentials
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/vaults/{id}/credentials",
  tags: ["Credentials"],
  summary: "Create a vault credential",
  description:
    "Creates a structured credential in the vault. The secret token is encrypted at rest and never returned in API responses.",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: CreateCredentialRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Credential created",
      content: { "application/json": { schema: VaultCredentialSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/vaults/{id}/credentials",
  tags: ["Credentials"],
  summary: "List vault credentials",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Credential list",
      content: { "application/json": { schema: CredentialListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/vaults/{id}/credentials/{credId}",
  tags: ["Credentials"],
  summary: "Get a vault credential",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string(), credId: z.string() }) },
  responses: {
    200: {
      description: "Credential retrieved",
      content: { "application/json": { schema: VaultCredentialSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/vaults/{id}/credentials/{credId}",
  tags: ["Credentials"],
  summary: "Update a vault credential",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string(), credId: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: UpdateCredentialRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Credential updated",
      content: { "application/json": { schema: VaultCredentialSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/vaults/{id}/credentials/{credId}",
  tags: ["Credentials"],
  summary: "Delete a vault credential",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string(), credId: z.string() }) },
  responses: {
    200: {
      description: "Credential deleted",
      content: { "application/json": { schema: CredentialDeletedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/vaults/{id}/entries
// ---------------------------------------------------------------------------

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
// /v1/memory_stores + /v1/memory_stores/{id}/memories
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/memory_stores",
  tags: ["Memory"],
  summary: "Create a memory store",
  security: [{ ApiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateMemoryStoreRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Memory store created",
      content: { "application/json": { schema: MemoryStoreSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/memory_stores",
  tags: ["Memory"],
  summary: "List memory stores",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      agent_id: z.string().optional().describe("Filter by agent ID"),
    }),
  },
  responses: {
    200: {
      description: "Memory store list",
      content: { "application/json": { schema: MemoryStoreListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/memory_stores/{id}",
  tags: ["Memory"],
  summary: "Get a memory store",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Memory store retrieved",
      content: { "application/json": { schema: MemoryStoreSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/memory_stores/{id}",
  tags: ["Memory"],
  summary: "Delete a memory store",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Memory store deleted",
      content: { "application/json": { schema: MemoryStoreDeletedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/memory_stores/{id}/memories",
  tags: ["Memory"],
  summary: "Create or upsert a memory",
  description:
    "Creates a new memory at the given path, or upserts if the path already exists in this store.",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: CreateMemoryRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Memory created",
      content: { "application/json": { schema: MemorySchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/memory_stores/{id}/memories",
  tags: ["Memory"],
  summary: "List memories in a store",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Memory list",
      content: { "application/json": { schema: MemoryListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/memory_stores/{id}/memories/{memId}",
  tags: ["Memory"],
  summary: "Get a memory",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string(), memId: z.string() }) },
  responses: {
    200: {
      description: "Memory retrieved",
      content: { "application/json": { schema: MemorySchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/memory_stores/{id}/memories/{memId}",
  tags: ["Memory"],
  summary: "Update a memory's content",
  description:
    "Updates the content of a memory. Optionally provide `content_sha256` for optimistic concurrency — returns 409 if the hash doesn't match.",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string(), memId: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: UpdateMemoryRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Memory updated",
      content: { "application/json": { schema: MemorySchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/memory_stores/{id}/memories/{memId}",
  tags: ["Memory"],
  summary: "Delete a memory",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string(), memId: z.string() }) },
  responses: {
    200: {
      description: "Memory deleted",
      content: { "application/json": { schema: MemoryDeletedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/skills
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/v1/skills/catalog",
  tags: ["Skills"],
  summary: "Get skills catalog (legacy feed)",
  description: "Returns top skills from the feed, grouped by leaderboard.",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      leaderboard: z.enum(["trending", "hot", "allTime"]).optional().describe("Leaderboard to query. Defaults to 'trending'."),
      limit: z.coerce.number().int().optional(),
    }),
  },
  responses: {
    200: {
      description: "Skills catalog",
      content: { "application/json": { schema: SkillsCatalogResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/skills",
  tags: ["Skills"],
  summary: "Search the full skills index",
  description: "Full-text search across 72k+ skills with filters, pagination, and sorting.",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      q: z.string().optional().describe("Free-text search query."),
      owner: z.string().optional().describe("Filter by skill owner/author."),
      source: z.string().optional().describe("Filter by source repository."),
      sort: z.enum(["installs", "name", "created"]).optional(),
      limit: z.coerce.number().int().optional(),
      offset: z.coerce.number().int().optional(),
    }),
  },
  responses: {
    200: {
      description: "Search results",
      content: { "application/json": { schema: SkillsSearchResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/skills",
  tags: ["Skills"],
  summary: "Create a standalone skill (stub)",
  description: "Not yet supported. Returns 501. Add skills directly to agents via the skills[] field.",
  security: [{ ApiKey: [] }],
  responses: {
    501: {
      description: "Not implemented",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/skills/{id}",
  tags: ["Skills"],
  summary: "Delete a standalone skill (stub)",
  description: "Not yet supported. Returns 501. Remove skills from agents via PATCH /v1/agents.",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    501: {
      description: "Not implemented",
      content: { "application/json": { schema: ErrorEnvelopeSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/skills/stats",
  tags: ["Skills"],
  summary: "Get skills statistics",
  security: [{ ApiKey: [] }],
  responses: {
    200: {
      description: "Skills stats",
      content: { "application/json": { schema: SkillsStatsResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/skills/sources",
  tags: ["Skills"],
  summary: "List skill sources",
  description: "Returns aggregated source repositories sorted by install count.",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().optional(),
      offset: z.coerce.number().int().optional(),
    }),
  },
  responses: {
    200: {
      description: "Skill sources",
      content: { "application/json": { schema: SkillsSourcesResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/skills/index",
  tags: ["Skills"],
  summary: "Get the full skills index",
  description: "Returns the complete skills index as raw data.",
  security: [{ ApiKey: [] }],
  responses: {
    200: {
      description: "Full skills index",
      content: { "application/json": { schema: z.record(z.unknown()).openapi({ description: "Raw skills index data." }) } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/skills/feed",
  tags: ["Skills"],
  summary: "Get raw skills feed data",
  security: [{ ApiKey: [] }],
  responses: {
    200: {
      description: "Raw feed data",
      content: { "application/json": { schema: z.record(z.unknown()).openapi({ description: "Raw feed data including topTrending, topHot, topAllTime." }) } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/settings
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "put",
  path: "/v1/settings",
  tags: ["Settings"],
  summary: "Update a setting",
  description:
    "Persists a setting value. Secret settings (API keys, tokens) are stored encrypted and never returned in plaintext.",
  security: [{ ApiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: PutSettingRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Setting saved",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/settings/{key}",
  tags: ["Settings"],
  summary: "Read a setting",
  description:
    "Returns the setting value. Secret keys return a masked preview (e.g. 'sk-an........lAQR') with `masked: true`.",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: {
      description: "Setting value",
      content: { "application/json": { schema: SettingResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/providers/status
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/v1/providers/status",
  tags: ["Providers"],
  summary: "Get provider availability status",
  description:
    "Checks availability of all supported container providers (local: Docker, Apple Container, Podman; cloud: Sprites, E2B, Vercel, Daytona, Fly, Modal).",
  security: [{ ApiKey: [] }],
  responses: {
    200: {
      description: "Provider status map",
      content: { "application/json": { schema: ProviderStatusResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/traces + /v1/metrics
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/v1/traces",
  tags: ["Traces"],
  summary: "List recent traces",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      session_id: z.string().optional().describe("Filter by session ID."),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "List of traces",
      content: { "application/json": { schema: TraceListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/traces/{id}",
  tags: ["Traces"],
  summary: "Get a trace with full event log and span tree",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().optional().describe("Max events to return. Defaults to 2000."),
    }),
  },
  responses: {
    200: {
      description: "Trace detail",
      content: { "application/json": { schema: TraceDetailSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/traces/{id}/export",
  tags: ["Traces"],
  summary: "Export a trace via OTLP",
  description: "Triggers a synchronous OTLP export for the trace, bypassing the auto-export hook.",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Export result",
      content: { "application/json": { schema: TraceExportResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/metrics",
  tags: ["Metrics"],
  summary: "Get session-level metrics",
  description:
    "On-read aggregation over sessions + events tables. Supports grouping by agent, environment, backend, hour, day, or api_key. Time-series mode available with `time_bucket` param.",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      group_by: z.enum(["agent", "environment", "backend", "hour", "day", "api_key", "none"]).optional(),
      from: z.coerce.number().optional().describe("Start of window in ms since epoch. Defaults to 0."),
      to: z.coerce.number().optional().describe("End of window in ms since epoch. Defaults to now."),
      agent_id: z.string().optional(),
      environment_id: z.string().optional(),
      time_bucket: z.enum(["hour", "day", "week"]).optional().describe("Time-series bucket size. Only used with group_by=api_key."),
    }),
  },
  responses: {
    200: {
      description: "Metrics snapshot",
      content: { "application/json": { schema: MetricsResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/metrics/api",
  tags: ["Metrics"],
  summary: "Get API throughput and latency metrics",
  description:
    "Global-admin-only. Returns real-time API throughput, latency percentiles, and status code distribution from an in-process ring buffer.",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      window_minutes: z.coerce.number().int().min(1).max(60).optional().describe("Rolling window in minutes. Defaults to 60."),
    }),
  },
  responses: {
    200: {
      description: "API metrics snapshot",
      content: { "application/json": { schema: ApiMetricsResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/api-keys
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/api-keys",
  tags: ["API Keys"],
  summary: "Create an API key",
  description:
    "Admin-only. Creates a new virtual API key. The raw key value is returned ONCE in the response and must be stored by the caller.",
  security: [{ ApiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateApiKeyRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "API key created (includes raw key)",
      content: { "application/json": { schema: ApiKeyCreatedSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/api-keys",
  tags: ["API Keys"],
  summary: "List API keys",
  description: "Admin-only. Returns all non-revoked API keys (without raw key values).",
  security: [{ ApiKey: [] }],
  responses: {
    200: {
      description: "API key list",
      content: { "application/json": { schema: ApiKeyListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/api-keys/{id}",
  tags: ["API Keys"],
  summary: "Get an API key",
  description: "Admin-only.",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "API key details",
      content: { "application/json": { schema: ApiKeySchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/api-keys/{id}",
  tags: ["API Keys"],
  summary: "Update an API key's permissions",
  description: "Admin-only.",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: PatchApiKeyRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "API key updated",
      content: { "application/json": { schema: ApiKeySchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/api-keys/{id}",
  tags: ["API Keys"],
  summary: "Revoke an API key",
  description: "Admin-only. A key cannot revoke itself.",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "API key revoked",
      content: { "application/json": { schema: ApiKeyRevokedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/api-keys/{id}/activity",
  tags: ["API Keys"],
  summary: "Get API key activity and cost attribution",
  description: "Admin-only (enterprise). Returns recent sessions, total cost, and error counts for a specific API key.",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Key activity",
      content: { "application/json": { schema: ApiKeyActivityResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/upstream-keys
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/upstream-keys",
  tags: ["Upstream Keys"],
  summary: "Add an upstream key to the pool",
  description: "Global-admin-only (enterprise). Adds a provider API key to the round-robin pool. Value is encrypted at rest.",
  security: [{ ApiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AddUpstreamKeyRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Upstream key added",
      content: { "application/json": { schema: UpstreamKeySchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/upstream-keys",
  tags: ["Upstream Keys"],
  summary: "List upstream keys",
  description: "Global-admin-only (enterprise).",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      provider: z.string().optional().describe("Filter by provider (anthropic, openai, gemini)."),
    }),
  },
  responses: {
    200: {
      description: "Upstream key list",
      content: { "application/json": { schema: UpstreamKeyListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/upstream-keys/{id}",
  tags: ["Upstream Keys"],
  summary: "Get an upstream key",
  description: "Global-admin-only (enterprise).",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Upstream key details",
      content: { "application/json": { schema: UpstreamKeySchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/upstream-keys/{id}",
  tags: ["Upstream Keys"],
  summary: "Enable or disable an upstream key",
  description: "Global-admin-only (enterprise).",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: PatchUpstreamKeyRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Upstream key updated",
      content: { "application/json": { schema: UpstreamKeySchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/upstream-keys/{id}",
  tags: ["Upstream Keys"],
  summary: "Delete an upstream key from the pool",
  description: "Global-admin-only (enterprise).",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Upstream key deleted",
      content: { "application/json": { schema: UpstreamKeyDeletedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/tenants
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "post",
  path: "/v1/tenants",
  tags: ["Tenants"],
  summary: "Create a tenant",
  description: "Global-admin-only (enterprise). Creates a new tenant for multi-tenant isolation.",
  security: [{ ApiKey: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateTenantRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Tenant created",
      content: { "application/json": { schema: TenantSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/tenants",
  tags: ["Tenants"],
  summary: "List tenants",
  description: "Global-admin-only (enterprise).",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      include_archived: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Tenant list",
      content: { "application/json": { schema: TenantListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/tenants/{id}",
  tags: ["Tenants"],
  summary: "Get a tenant",
  description: "Global-admin-only (enterprise).",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Tenant details",
      content: { "application/json": { schema: TenantSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/tenants/{id}",
  tags: ["Tenants"],
  summary: "Update a tenant",
  description: "Global-admin-only (enterprise). Currently supports renaming.",
  security: [{ ApiKey: [] }],
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: PatchTenantRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Tenant updated",
      content: { "application/json": { schema: TenantSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/tenants/{id}",
  tags: ["Tenants"],
  summary: "Archive a tenant",
  description: "Global-admin-only (enterprise). Cannot archive the default tenant.",
  security: [{ ApiKey: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Tenant archived",
      content: { "application/json": { schema: TenantArchivedResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/audit-log
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/v1/audit-log",
  tags: ["Audit"],
  summary: "List audit log entries",
  description:
    "Admin-only. Returns the append-only admin audit trail. Global admins see all entries; tenant admins see entries for their own tenant.",
  security: [{ ApiKey: [] }],
  request: {
    query: z.object({
      limit: z.coerce.number().int().optional(),
      page: z.string().optional().describe("ULID cursor for pagination."),
      action: z.string().optional().describe("Filter by action, e.g. 'tenants.create'."),
      actor_key_id: z.string().optional(),
      resource_type: z.string().optional(),
      resource_id: z.string().optional(),
      outcome: z.enum(["success", "denied", "failure"]).optional(),
      "created_at[gte]": z.string().optional().describe("Start of time range (ms or ISO string)."),
      "created_at[lte]": z.string().optional().describe("End of time range (ms or ISO string)."),
    }),
  },
  responses: {
    200: {
      description: "Audit log entries",
      content: { "application/json": { schema: AuditListResponseSchema } },
    },
    ...ErrorResponses,
  },
});

// ---------------------------------------------------------------------------
// /v1/whoami + /v1/license
// ---------------------------------------------------------------------------

registry.registerPath({
  method: "get",
  path: "/v1/whoami",
  tags: ["Auth"],
  summary: "Get caller identity",
  description:
    "Returns the minimal auth context for the authenticated API key: name, tenant, admin status, and permissions.",
  security: [{ ApiKey: [] }],
  responses: {
    200: {
      description: "Caller identity",
      content: { "application/json": { schema: WhoamiResponseSchema } },
    },
    ...ErrorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/license",
  tags: ["Auth"],
  summary: "Get license info",
  description:
    "Returns the plan tier (community/enterprise) and enabled features. No auth required. The raw license key is never returned.",
  security: [{ ApiKey: [] }],
  responses: {
    200: {
      description: "License info",
      content: { "application/json": { schema: LicenseResponseSchema } },
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
      version: "0.4.0",
      description:
        "Open-source, drop-in replacement for the Claude Managed Agents API. Self-hosted agent gateway with 7 agent harnesses and 11 sandbox providers. Use with `@agentstep/agent-sdk` or the official Anthropic SDK — just change the baseURL.",
    },
    servers: [{ url: opts.serverUrl, description: "This host" }],
    security: [{ ApiKey: [] }],
    tags: [
      { name: "Agents", description: "Agent CRUD and versioning" },
      { name: "Environments", description: "Container environment management" },
      { name: "Sessions", description: "Session lifecycle management" },
      { name: "Events", description: "Event append, history, and streaming" },
      { name: "Resources", description: "Session resource attachments" },
      { name: "Files", description: "File upload, download, and management" },
      { name: "Vaults", description: "Secret vault management" },
      { name: "Credentials", description: "Vault credential CRUD (structured auth)" },
      { name: "Memory", description: "Memory stores and memories" },
      { name: "Skills", description: "Skills catalog, search, and management" },
      { name: "Settings", description: "Gateway configuration settings" },
      { name: "Providers", description: "Container provider status" },
      { name: "Traces", description: "Distributed tracing and span trees" },
      { name: "Metrics", description: "Session and API metrics" },
      { name: "API Keys", description: "Virtual API key management (admin-only)" },
      { name: "Upstream Keys", description: "Upstream provider key pool (global-admin-only)" },
      { name: "Tenants", description: "Multi-tenant isolation (global-admin-only)" },
      { name: "Audit", description: "Admin audit trail" },
      { name: "Auth", description: "Caller identity and license info" },
      { name: "Batch", description: "Atomic batch operations" },
    ],
  });
}
