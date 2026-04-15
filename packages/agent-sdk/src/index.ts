/**
 * @agentstep/agent-sdk — framework-agnostic Managed Agents engine.
 *
 * This is the public API surface. Adapters (Next.js, Hono, etc.) import
 * from here or from subpath exports like `@agentstep/agent-sdk/db/agents`.
 */

// HTTP helpers
export { routeWrap, jsonOk, type RouteContext } from "./http";

// Errors
export {
  ApiError,
  envelope,
  toResponse,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooManyRequests,
  serverBusy,
  type ErrorType,
} from "./errors";

// Init + shutdown
export { ensureInitialized } from "./init";
export { installShutdownHandlers } from "./shutdown";

// Auth
export { authenticate } from "./auth/middleware";

// Types
export type {
  Agent,
  AuthContext,
  EventRow,
  ManagedEvent,
  McpServerConfig,
  SessionStatus,
} from "./types";

// State
export { pushPendingUserInput, type TurnInput } from "./state";

// DB
export { getDb } from "./db/client";
export { createApiKey, listApiKeys } from "./db/api_keys";
export { createAgent, getAgent, updateAgent, archiveAgent, listAgents } from "./db/agents";
export {
  createSession,
  getSession,
  getSessionRow,
  listSessions,
  updateSessionMutable,
  archiveSession,
  setOutcomeCriteria,
} from "./db/sessions";
export {
  createEnvironment,
  getEnvironment,
  listEnvironments,
  archiveEnvironment,
  deleteEnvironment,
  hasSessionsAttached,
} from "./db/environments";
export { appendEventsBatch, listEvents, rowToManagedEvent } from "./db/events";
export { createVault, getVault, deleteVault, listVaults, listEntries, getEntry, setEntry, deleteEntry } from "./db/vaults";
export {
  createMemoryStore, getMemoryStore, listMemoryStores, deleteMemoryStore,
  createOrUpsertMemory, getMemory, getMemoryByPath, listMemories, updateMemory, deleteMemory,
} from "./db/memory";
export { executeBatch, BatchError } from "./db/batch";
export { isProxied, markProxied, unmarkProxied } from "./db/proxy";

// Sessions
export { appendEvent, subscribe, dropEmitter } from "./sessions/bus";
export { getActor, dropActor } from "./sessions/actor";
export { interruptSession } from "./sessions/interrupt";
export { runTurn, writePermissionResponse } from "./sessions/driver";
export { injectMcpAuthHeaders } from "./sessions/mcp-auth";

// Queue
export { enqueueTurn } from "./queue";

// Backends
export { resolveBackend } from "./backends/registry";

// Providers
export { resolveContainerProvider } from "./providers/registry";

// Proxy
export { forwardToAnthropic, validateAnthropicProxy } from "./proxy/forward";

// Container lifecycle
export { releaseSession } from "./containers/lifecycle";
export { kickoffEnvironmentSetup } from "./containers/setup";

// OpenAPI
export { buildOpenApiDocument } from "./openapi/spec";

// Config
export { getConfig } from "./config";

// Utils
export { nowMs } from "./util/clock";
