/**
 * @agentstep/gateway-hono — Hono adapter for the Managed Agents API.
 *
 * All business logic lives in @agentstep/agent-sdk. This file registers
 * routes and delegates to core handler functions.
 */
import { Hono, type Context } from "hono";
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
  handleGetSetting,
  handleGetProviderStatus,
  handleGetSkillsCatalog,
  handleSearchSkills,
  handleGetSkillsStats,
  handleGetSkillsSources,
  handleGetSkillsIndex,
  handleGetSkillsFeed,
  handleGetTrace,
  handleListTraces,
  handleExportTrace,
  handleGetMetrics,
  handleGetApiMetrics,
  handleUploadFile,
  handleListFiles,
  handleGetFile,
  handleGetFileContent,
  handleDeleteFile,
  handleAddResource,
  handleListResources,
  handleDeleteResource,
} from "@agentstep/agent-sdk/handlers";

const app = new Hono();

// ── Built-in Web UI helper ────────────────────────────────────────────────
//
// Security: the UI HTML injects window.__MA_API_KEY__ so the SPA can call
// the API without asking the user to paste a key. That convenience is only
// safe when the request is from the loopback interface. When the server is
// bound to 0.0.0.0 and reached from the LAN, we serve the UI *without* the
// key — the user has to paste it via the UI's "API Key" input (stored in
// localStorage).
//
// Reverse-proxy deployments: running on the same host behind Caddy/Nginx
// means the socket.remoteAddress is *always* 127.0.0.1 (the proxy),
// which would otherwise cause us to inject the key for public clients.
// Require TRUST_PROXY=1 to opt in to X-Forwarded-For honoring; without
// it, behind-a-proxy deployments fail closed (no key injection at all).
// The UI still works — users just paste the API key once into localStorage.
function isLoopbackRemote(c: Context): boolean {
  const trustProxy = process.env.TRUST_PROXY === "1";
  if (trustProxy) {
    // When TRUST_PROXY is set, the reverse proxy is responsible for
    // stripping spoofed headers from incoming requests. We honor the
    // leftmost forwarded address so loopback clients through a proxy
    // still auto-login.
    const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const realIp = c.req.header("x-real-ip");
    const proxied = forwardedFor ?? realIp;
    if (proxied) {
      const addr = proxied.replace(/^::ffff:/, "");
      return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
    }
  }
  // Default: trust only the raw socket.
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const raw = env?.incoming?.socket?.remoteAddress ?? "";
  const addr = raw.replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

const serveUI = (c: Context) =>
  handleGetUI({
    apiKey: isLoopbackRemote(c) ? process.env.SEED_API_KEY : undefined,
    version: process.env.GATEWAY_VERSION,
    sentryDsn: process.env.SENTRY_DSN,
  });

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

// ── Session Resources ───────────────────────────────────────────────────
app.post("/v1/sessions/:id/resources", (c) => handleAddResource(c.req.raw, c.req.param("id")));
app.get("/v1/sessions/:id/resources", (c) => handleListResources(c.req.raw, c.req.param("id")));
app.delete("/v1/sessions/:id/resources/:rid", (c) => handleDeleteResource(c.req.raw, c.req.param("id"), c.req.param("rid")));

// ── Files ────────────────────────────────────────────────────────────────
app.post("/v1/files", (c) => handleUploadFile(c.req.raw));
app.get("/v1/files", (c) => handleListFiles(c.req.raw));
app.get("/v1/files/:id", (c) => handleGetFile(c.req.raw, c.req.param("id")));
app.get("/v1/files/:id/content", (c) => handleGetFileContent(c.req.raw, c.req.param("id")));
app.delete("/v1/files/:id", (c) => handleDeleteFile(c.req.raw, c.req.param("id")));

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
app.get("/v1/settings/:key", (c) => handleGetSetting(c.req.raw, c.req.param("key")));

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

// ── Observability: traces + metrics ──────────────────────────────────────
app.get("/v1/traces", (c) => handleListTraces(c.req.raw));
app.get("/v1/traces/:id", (c) => handleGetTrace(c.req.raw, c.req.param("id")));
app.post("/v1/traces/:id/export", (c) => handleExportTrace(c.req.raw, c.req.param("id")));
// NOTE: /v1/metrics/api must be registered BEFORE /v1/metrics so the
// exact-match doesn't shadow it. Hono matches in registration order.
app.get("/v1/metrics/api", (c) => handleGetApiMetrics(c.req.raw));
app.get("/v1/metrics", (c) => handleGetMetrics(c.req.raw));

// ── SPA catch-all (must be last) ────────────────────────────────────────────
app.get("*", (c) => {
  const path = c.req.path;
  if (path.startsWith("/v1/") || path.startsWith("/api/")) {
    return c.json({ error: { type: "not_found_error", message: "Not found" } }, 404);
  }
  return serveUI(c);
});

export default app;
