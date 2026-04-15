/**
 * @agentstep/gateway-hono — Hono adapter for the Managed Agents API.
 *
 * All business logic lives in @agentstep/agent-sdk. This file registers
 * routes and delegates to core handler functions.
 */
import { Hono } from "hono";
import {
  handleCreateAgent,
  handleListAgents,
  handleGetAgent,
  handleUpdateAgent,
  handleDeleteAgent,
  handleCreateEnvironment,
  handleListEnvironments,
  handleGetEnvironment,
  handleUpdateEnvironment,
  handleDeleteEnvironment,
  handleArchiveEnvironment,
  handleCreateSession,
  handleListSessions,
  handleGetSession,
  handleUpdateSession,
  handleDeleteSession,
  handleArchiveSession,
  handlePostEvents,
  handleListEvents,
  handleSessionStream,
  handleListThreads,
  handleCreateMemoryStore,
  handleListMemoryStores,
  handleGetMemoryStore,
  handleDeleteMemoryStore,
  handleCreateMemory,
  handleListMemories,
  handleGetMemory,
  handleUpdateMemory,
  handleDeleteMemory,
  handleCreateVault,
  handleListVaults,
  handleGetVault,
  handleDeleteVault,
  handleListEntries,
  handleGetEntry,
  handlePutEntry,
  handleDeleteEntry,
  handleBatch,
  handleGetOpenApiSpec,
  handleGetDocs,
  handleGetUI,
  handlePutSetting,
  handleGetProviderStatus,
  handleGetSkillsCatalog,
  handleSearchSkills,
  handleGetSkillsStats,
  handleGetSkillsSources,
  handleGetSkillsIndex,
  handleGetSkillsFeed,
} from "@agentstep/agent-sdk/handlers";

const app = new Hono();

// ── Built-in Web UI (SPA — serve index for all client routes) ────────────
const serveUI = () => handleGetUI({ apiKey: process.env.SEED_API_KEY, version: process.env.GATEWAY_VERSION, sentryDsn: process.env.SENTRY_DSN });
app.get("/", serveUI);
app.get("/settings", serveUI);
app.get("/settings/agents/:id", serveUI);
app.get("/sessions/:id", serveUI);

// ── Health ────────────────────────────────────────────────────────────────
app.get("/api/health", (c) => c.json({ status: "ok" }));

// ── OpenAPI (no auth) ────────────────────────────────────────────────────
app.get("/v1/openapi.json", (c) => handleGetOpenApiSpec(c.req.raw));
app.get("/v1/docs", () => handleGetDocs());

// ── Agents ───────────────────────────────────────────────────────────────
app.post("/v1/agents", (c) => handleCreateAgent(c.req.raw));
app.get("/v1/agents", (c) => handleListAgents(c.req.raw));
app.get("/v1/agents/:id", (c) => handleGetAgent(c.req.raw, c.req.param("id")));
app.post("/v1/agents/:id", (c) => handleUpdateAgent(c.req.raw, c.req.param("id")));
app.delete("/v1/agents/:id", (c) => handleDeleteAgent(c.req.raw, c.req.param("id")));

// ── Environments ─────────────────────────────────────────────────────────
app.post("/v1/environments", (c) => handleCreateEnvironment(c.req.raw));
app.get("/v1/environments", (c) => handleListEnvironments(c.req.raw));
app.get("/v1/environments/:id", (c) => handleGetEnvironment(c.req.raw, c.req.param("id")));
app.post("/v1/environments/:id", (c) => handleUpdateEnvironment(c.req.raw, c.req.param("id")));
app.delete("/v1/environments/:id", (c) => handleDeleteEnvironment(c.req.raw, c.req.param("id")));
app.post("/v1/environments/:id/archive", (c) => handleArchiveEnvironment(c.req.raw, c.req.param("id")));

// ── Sessions ─────────────────────────────────────────────────────────────
app.post("/v1/sessions", (c) => handleCreateSession(c.req.raw));
app.get("/v1/sessions", (c) => handleListSessions(c.req.raw));
app.get("/v1/sessions/:id", (c) => handleGetSession(c.req.raw, c.req.param("id")));
app.post("/v1/sessions/:id", (c) => handleUpdateSession(c.req.raw, c.req.param("id")));
app.delete("/v1/sessions/:id", (c) => handleDeleteSession(c.req.raw, c.req.param("id")));
app.post("/v1/sessions/:id/archive", (c) => handleArchiveSession(c.req.raw, c.req.param("id")));

// ── Events ───────────────────────────────────────────────────────────────
app.post("/v1/sessions/:id/events", (c) => handlePostEvents(c.req.raw, c.req.param("id")));
app.get("/v1/sessions/:id/events", (c) => handleListEvents(c.req.raw, c.req.param("id")));

// ── Stream (SSE) ─────────────────────────────────────────────────────────
app.get("/v1/sessions/:id/stream", (c) => handleSessionStream(c.req.raw, c.req.param("id")));

// ── Threads ──────────────────────────────────────────────────────────────
app.get("/v1/sessions/:id/threads", (c) => handleListThreads(c.req.raw, c.req.param("id")));

// ── Vaults ───────────────────────────────────────────────────────────────
app.post("/v1/vaults", (c) => handleCreateVault(c.req.raw));
app.get("/v1/vaults", (c) => handleListVaults(c.req.raw));
app.get("/v1/vaults/:id", (c) => handleGetVault(c.req.raw, c.req.param("id")));
app.delete("/v1/vaults/:id", (c) => handleDeleteVault(c.req.raw, c.req.param("id")));
app.get("/v1/vaults/:id/entries", (c) => handleListEntries(c.req.raw, c.req.param("id")));
app.get("/v1/vaults/:id/entries/:key", (c) => handleGetEntry(c.req.raw, c.req.param("id"), c.req.param("key")));
app.put("/v1/vaults/:id/entries/:key", (c) => handlePutEntry(c.req.raw, c.req.param("id"), c.req.param("key")));
app.delete("/v1/vaults/:id/entries/:key", (c) => handleDeleteEntry(c.req.raw, c.req.param("id"), c.req.param("key")));

// ── Memory Stores ────────────────────────────────────────────────────────
app.post("/v1/memory_stores", (c) => handleCreateMemoryStore(c.req.raw));
app.get("/v1/memory_stores", (c) => handleListMemoryStores(c.req.raw));
app.get("/v1/memory_stores/:id", (c) => handleGetMemoryStore(c.req.raw, c.req.param("id")));
app.delete("/v1/memory_stores/:id", (c) => handleDeleteMemoryStore(c.req.raw, c.req.param("id")));
app.post("/v1/memory_stores/:id/memories", (c) => handleCreateMemory(c.req.raw, c.req.param("id")));
app.get("/v1/memory_stores/:id/memories", (c) => handleListMemories(c.req.raw, c.req.param("id")));
app.get("/v1/memory_stores/:id/memories/:memId", (c) => handleGetMemory(c.req.raw, c.req.param("id"), c.req.param("memId")));
app.patch("/v1/memory_stores/:id/memories/:memId", (c) => handleUpdateMemory(c.req.raw, c.req.param("id"), c.req.param("memId")));
app.delete("/v1/memory_stores/:id/memories/:memId", (c) => handleDeleteMemory(c.req.raw, c.req.param("id"), c.req.param("memId")));

// ── Settings ─────────────────────────────────────────────────────────────
app.put("/v1/settings", (c) => handlePutSetting(c.req.raw));

// ── Providers ─────────────────────────────────────────────────────────────
app.get("/v1/providers/status", (c) => handleGetProviderStatus(c.req.raw));

// ── Skills ────────────────────────────────────────────────────────────
app.get("/v1/skills/catalog", (c) => handleGetSkillsCatalog(c.req.raw));
app.get("/v1/skills/stats", (c) => handleGetSkillsStats(c.req.raw));
app.get("/v1/skills/sources", (c) => handleGetSkillsSources(c.req.raw));
app.get("/v1/skills/index", (c) => handleGetSkillsIndex(c.req.raw));
app.get("/v1/skills/feed", (c) => handleGetSkillsFeed(c.req.raw));
app.get("/v1/skills", (c) => handleSearchSkills(c.req.raw));

// ── Batch ────────────────────────────────────────────────────────────────
app.post("/v1/batch", (c) => handleBatch(c.req.raw));

export default app;
