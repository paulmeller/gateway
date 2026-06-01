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
  handleArchiveAgent,
  handleListAgentVersions,
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
  handleGetDebugPrompt,
  handlePostEvents,
  handleListEvents,
  handleSessionStream,
  handleListThreads,
  handleGetThread,
  handleArchiveThread,
  handleListThreadEvents,
  handleStreamThreadEvents,
  handleCreateMemoryStore,
  handleListMemoryStores,
  handleGetMemoryStore,
  handleDeleteMemoryStore,
  handleCreateMemory,
  handleListMemories,
  handleGetMemory,
  handleUpdateMemory,
  handleDeleteMemory,
  handleListMemoryVersions,
  handleGetMemoryVersion,
  handleArchiveMemoryStore,
  handleCreateVault,
  handleListVaults,
  handleGetVault,
  handleUpdateVault,
  handleArchiveVault,
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
  handleListSkills,
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
  handleGetResource,
  handleDeleteResource,
  handleCreateApiKey,
  handleListApiKeys,
  handleGetApiKey,
  handlePatchApiKey,
  handleRevokeApiKey,
  handleGetApiKeyActivity,
  handleAddUpstreamKey,
  handleListUpstreamKeys,
  handleGetUpstreamKey,
  handlePatchUpstreamKey,
  handleDeleteUpstreamKey,
  handleCreateTenant,
  handleListTenants,
  handleGetTenant,
  handlePatchTenant,
  handleArchiveTenant,
  handleWhoami,
  handleListAudit,
  handleGetLicense,
  handleCreateSkill,
  handleGetSkill,
  handleDeleteSkill,
  handleCreateSkillVersion,
  handleListSkillVersions,
  handleGetSkillVersion,
  handleDeleteSkillVersion,
  handleGetSkillVersionContent,
  handleCreateCredential,
  handleListCredentials,
  handleGetCredential,
  handleUpdateCredential,
  handleArchiveCredential,
  handleDeleteCredential,
  handleMcpOauthValidate,
  handleUpdateMemoryStore,
  handleRedactMemoryVersion,
  handleDreamMemoryStore,
  handleUpdateResource,
  handleListModels,
  handleListWork,
  handleGetWork,
  handleUpdateWork,
  handlePollWork,
  handleWorkStats,
  handleAckWork,
  handleHeartbeatWork,
  handleStopWork,
  handleCreateUserProfile,
  handleListUserProfiles,
  handleGetUserProfile,
  handleUpdateUserProfile,
  handleEnrollmentUrl,
  handleOAuthCallback,
  handleCreateInteraction,
  handleGetInteraction,
  handleDeleteInteraction,
  handleCancelInteraction,
  handleCreateGoogleAgent,
  handleListGoogleAgents,
  handleGetGoogleAgent,
  handleDeleteGoogleAgent,
  handleGetEnvironmentFiles,
} from "@agentstep/agent-sdk/handlers";

import { cors } from "hono/cors";

const app = new Hono();

// CORS: only allow same-origin requests. Without this, any site can make
// authenticated API calls if the user's API key is in localStorage.
app.use("/v1/*", cors({ origin: (origin) => origin, credentials: true }));
app.use("/anthropic/v1/*", cors({ origin: (origin) => origin, credentials: true }));
app.use("/agentstep/v1/*", cors({ origin: (origin) => origin, credentials: true }));

// ── /v1/* Deprecation alias (PR8) ─────────────────────────────────────────
//
// Gateway-native routes now live at /agentstep/v1/* (the canonical
// surface). /v1/* keeps working as an alias for ≥1 release and
// every response gains an RFC 8594 `Deprecation` header pointing at
// the successor URL.
//
// Meta routes (/v1/openapi.json, /v1/docs) stay at /v1 — they aren't
// resource endpoints and we want the combined spec discoverable at
// the historical path. They get no Deprecation header.
//
// Requests forwarded internally from /agentstep/v1/* (canonical) to
// /v1/* (handler) carry the `x-internal-canonical` marker so the
// outer response isn't tagged.
app.use("/v1/*", async (c, next) => {
  await next();
  if (c.req.header("x-internal-canonical") === "agentstep") return;
  const p = c.req.path;
  if (p === "/v1/openapi.json" || p === "/v1/docs") return;
  c.header("Deprecation", "true");
  c.header(
    "Link",
    `<${p.replace(/^\/v1\//, "/agentstep/v1/")}>; rel="successor-version"`,
  );
});

// ── /agentstep/v1/* canonical-surface forwarder (PR8/PR9) ─────────────────
//
// Internally rewrite /agentstep/v1/<path> → /v1/<path> and re-enter
// the app. Single registration covers every gateway-native route
// without duplicating ~60 `app.{get,post,...}` lines. The
// `x-internal-canonical` header tells the /v1/* deprecation
// middleware "I'm already on the canonical surface, don't tag me."
//
// Specific /agentstep/v1/* routes that need different behavior than
// their /v1/* counterpart (openapi.json/docs filter to the
// gateway-native surface) MUST be registered ABOVE this catch-all
// so Hono's registration-order match picks them first.
//
// PR9 added a CMA-canonical-path guard: skills CRUD, memory_stores
// CRUD, models, and the environments/:id/work queue moved to
// /anthropic/v1/* — they're CMA, not AgentStep. A request to e.g.
// /agentstep/v1/skills would otherwise forward to /v1/skills (no
// longer mounted) and 404 with no explanation. We 404 those paths
// here with a clear pointer at the canonical URL instead.
const CMA_CANONICAL_PATH_PATTERNS: RegExp[] = [
  /^\/agentstep\/v1\/skills(\/.*)?$/, // catalog/feed/index/sources/stats are agentstep — see below
  /^\/agentstep\/v1\/memory_stores(\/.*)?$/, // /dream is agentstep — see below
  /^\/agentstep\/v1\/models(\/.*)?$/,
  /^\/agentstep\/v1\/environments\/[^/]+\/work(\/.*)?$/,
];
const AGENTSTEP_EXTENSION_PATHS = new Set([
  // Discovery extensions sitting under the CMA skills resource.
  "/agentstep/v1/skills/catalog",
  "/agentstep/v1/skills/stats",
  "/agentstep/v1/skills/sources",
  "/agentstep/v1/skills/index",
  "/agentstep/v1/skills/feed",
]);
const AGENTSTEP_EXTENSION_DYNAMIC: RegExp[] = [
  // /memory_stores/:id/dream — consolidation pass, AgentStep-only.
  /^\/agentstep\/v1\/memory_stores\/[^/]+\/dream$/,
];
function isCmaCanonicalUnderAgentstep(path: string): boolean {
  if (AGENTSTEP_EXTENSION_PATHS.has(path)) return false;
  if (AGENTSTEP_EXTENSION_DYNAMIC.some((re) => re.test(path))) return false;
  return CMA_CANONICAL_PATH_PATTERNS.some((re) => re.test(path));
}
const agentstepCanonicalForward = async (c: Context): Promise<Response> => {
  if (isCmaCanonicalUnderAgentstep(c.req.path)) {
    const canonical = c.req.path.replace(/^\/agentstep\/v1\//, "/anthropic/v1/");
    return c.json(
      {
        type: "error",
        error: {
          type: "not_found_error",
          message:
            `${c.req.path} is a CMA-canonical resource and lives at ${canonical}. ` +
            `The /agentstep/v1/* surface is gateway-native only — see /anthropic/v1/openapi.json for CMA-shape routes.`,
        },
      },
      404,
      { Link: `<${canonical}>; rel="canonical"` },
    );
  }
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/agentstep\/v1\//, "/v1/");
  const innerReq = new Request(url, c.req.raw);
  innerReq.headers.set("x-internal-canonical", "agentstep");
  return app.fetch(innerReq, c.env);
};

// Security headers for all responses
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  // Allow /v1/docs to be iframed by the SPA (same-origin)
  c.header("X-Frame-Options", c.req.path === "/v1/docs" ? "SAMEORIGIN" : "DENY");
  c.header("Referrer-Policy", "same-origin");
});

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
// Canonical gateway-native surface (PR8). handleGetOpenApiSpec reads
// the URL path → emits the /agentstep/v1/* filtered doc.
app.get("/agentstep/v1/openapi.json", (c) => handleGetOpenApiSpec(c.req.raw));
app.get("/agentstep/v1/docs", () => handleGetDocs());
// Anthropic-shape + Google-compat per-surface specs.
app.get("/anthropic/v1/openapi.json", (c) => handleGetOpenApiSpec(c.req.raw));
app.get("/google/v1beta/openapi.json", (c) => handleGetOpenApiSpec(c.req.raw));
// Catch-all canonical forwarder. Registered AFTER the specific
// /agentstep/v1/openapi.json + /agentstep/v1/docs so they take
// precedence. Every other /agentstep/v1/* path is rewritten to
// /v1/* and re-dispatched in-process.
app.all("/agentstep/v1/*", agentstepCanonicalForward);

// ── Agents ───────────────────────────────────────────────────────────────
app.post("/anthropic/v1/agents", (c) => handleCreateAgent(c.req.raw));
app.get("/anthropic/v1/agents", (c) => handleListAgents(c.req.raw));
// Sub-resource routes must be registered BEFORE the generic :id routes
app.post("/anthropic/v1/agents/:id/archive", (c) => handleArchiveAgent(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/agents/:id/versions", (c) => handleListAgentVersions(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/agents/:id", (c) => handleGetAgent(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/agents/:id", (c) => handleUpdateAgent(c.req.raw, c.req.param("id")));
app.delete("/anthropic/v1/agents/:id", (c) => handleDeleteAgent(c.req.raw, c.req.param("id")));

// ── Environments ─────────────────────────────────────────────────────────
app.post("/anthropic/v1/environments", (c) => handleCreateEnvironment(c.req.raw));
app.get("/anthropic/v1/environments", (c) => handleListEnvironments(c.req.raw));
// Work queue routes (self_hosted environments) — must be before generic :id routes
app.get("/anthropic/v1/environments/:id/work/poll", (c) => handlePollWork(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/environments/:id/work/stats", (c) => handleWorkStats(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/environments/:id/work/:workId/ack", (c) => handleAckWork(c.req.raw, c.req.param("id"), c.req.param("workId")));
app.post("/anthropic/v1/environments/:id/work/:workId/heartbeat", (c) => handleHeartbeatWork(c.req.raw, c.req.param("id"), c.req.param("workId")));
app.post("/anthropic/v1/environments/:id/work/:workId/stop", (c) => handleStopWork(c.req.raw, c.req.param("id"), c.req.param("workId")));
app.get("/anthropic/v1/environments/:id/work/:workId", (c) => handleGetWork(c.req.raw, c.req.param("id"), c.req.param("workId")));
app.post("/anthropic/v1/environments/:id/work/:workId", (c) => handleUpdateWork(c.req.raw, c.req.param("id"), c.req.param("workId")));
app.get("/anthropic/v1/environments/:id/work", (c) => handleListWork(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/environments/:id/archive", (c) => handleArchiveEnvironment(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/environments/:id", (c) => handleGetEnvironment(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/environments/:id", (c) => handleUpdateEnvironment(c.req.raw, c.req.param("id")));
app.delete("/anthropic/v1/environments/:id", (c) => handleDeleteEnvironment(c.req.raw, c.req.param("id")));

// ── Sessions ─────────────────────────────────────────────────────────────
app.post("/anthropic/v1/sessions", (c) => handleCreateSession(c.req.raw));
app.get("/anthropic/v1/sessions", (c) => handleListSessions(c.req.raw));
app.get("/anthropic/v1/sessions/:id", (c) => handleGetSession(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/sessions/:id", (c) => handleUpdateSession(c.req.raw, c.req.param("id")));
app.delete("/anthropic/v1/sessions/:id", (c) => handleDeleteSession(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/sessions/:id/archive", (c) => handleArchiveSession(c.req.raw, c.req.param("id")));

// Debug-prompt capture (gateway-native, not Anthropic-compat).
// GET returns the assembled-prompt JSON dumped at first-turn time
// when the session was created with `?debug=prompt` or `X-AgentStep-Debug: prompt`.
app.get("/v1/sessions/:id/debug-prompt", (c) => handleGetDebugPrompt(c.req.raw, c.req.param("id")));

// ── Events ───────────────────────────────────────────────────────────────
app.post("/anthropic/v1/sessions/:id/events", (c) => handlePostEvents(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/sessions/:id/events", (c) => handleListEvents(c.req.raw, c.req.param("id")));

// ── Stream (SSE) ─────────────────────────────────────────────────────────
// Uses Hono's streamSSE helper instead of raw Response for Node.js compat.
// @hono/node-server buffers raw ReadableStream responses; streamSSE flushes
// each chunk immediately which SSE requires.
import { streamSSE } from "hono/streaming";
import { prepareSessionStream } from "@agentstep/agent-sdk/handlers";
import { listEvents, rowToManagedEvent } from "@agentstep/agent-sdk";
app.get("/anthropic/v1/sessions/:id/events/stream", async (c) => {
  const sessionId = c.req.param("id");
  const prepared = await prepareSessionStream(c.req.raw, sessionId);

  // If prepareSessionStream returned a Response (error or proxy forward), return it directly
  if (prepared instanceof Response) return prepared;

  const { afterSeq, subscribeFn } = prepared;
  return streamSSE(c, async (stream) => {
    // Queue for events — the subscribe callback fires synchronously for
    // backlog and asynchronously for live events from the EventEmitter.
    const pending: Array<{ seq: number; type: string; data: string }> = [];

    const sub = subscribeFn(afterSeq, (evt) => {
      pending.push({ seq: evt.seq, type: evt.type, data: JSON.stringify(evt) });
    });

    stream.onAbort(() => { sub.unsubscribe(); });

    // Main loop: drain pending events, poll DB for external writes, keepalive.
    // The EventEmitter handles events from this process. DB polling catches
    // events written by remote workers (separate processes sharing SQLite).
    let lastPing = Date.now();
    let lastDbPoll = Date.now();
    let highestSeq = afterSeq;
    const DB_POLL_INTERVAL = 2000; // Poll DB every 2s for remote worker events

    while (!c.req.raw.signal.aborted) {
      // Drain all pending events (from EventEmitter)
      while (pending.length > 0) {
        const evt = pending.shift()!;
        await stream.writeSSE({ id: String(evt.seq), event: evt.type, data: evt.data });
        if (evt.seq > highestSeq) highestSeq = evt.seq;
      }

      // DB polling: catch events written by remote workers
      const now = Date.now();
      if (now - lastDbPoll >= DB_POLL_INTERVAL) {
        try {
          const newEvents = listEvents(sessionId, { limit: 100, order: "asc", afterSeq: highestSeq });
          for (const row of newEvents) {
            if (row.seq > highestSeq) {
              const evt = rowToManagedEvent(row);
              await stream.writeSSE({
                id: String(evt.seq),
                event: evt.type,
                data: JSON.stringify(evt),
              });
              highestSeq = evt.seq;
            }
          }
        } catch { /* best effort — DB may not be available */ }
        lastDbPoll = now;
      }

      // Keepalive ping every 15s
      if (now - lastPing > 15000) {
        await stream.writeSSE({ data: JSON.stringify({ type: "ping" }), event: "ping" });
        lastPing = now;
      }

      await stream.sleep(500);
    }
    sub.unsubscribe();
  });
});

// ── Session Resources ───────────────────────────────────────────────────
app.post("/anthropic/v1/sessions/:id/resources", (c) => handleAddResource(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/sessions/:id/resources", (c) => handleListResources(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/sessions/:id/resources/:rid", (c) => handleGetResource(c.req.raw, c.req.param("id"), c.req.param("rid")));
app.post("/anthropic/v1/sessions/:id/resources/:rid", (c) => handleUpdateResource(c.req.raw, c.req.param("id"), c.req.param("rid")));
app.delete("/anthropic/v1/sessions/:id/resources/:rid", (c) => handleDeleteResource(c.req.raw, c.req.param("id"), c.req.param("rid")));

// ── Files ────────────────────────────────────────────────────────────────
app.post("/anthropic/v1/files", (c) => handleUploadFile(c.req.raw));
app.get("/anthropic/v1/files", (c) => handleListFiles(c.req.raw));
app.get("/anthropic/v1/files/:id", (c) => handleGetFile(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/files/:id/content", (c) => handleGetFileContent(c.req.raw, c.req.param("id")));
app.delete("/anthropic/v1/files/:id", (c) => handleDeleteFile(c.req.raw, c.req.param("id")));

// ── Threads ──────────────────────────────────────────────────────────────
app.get("/anthropic/v1/sessions/:id/threads", (c) => handleListThreads(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/sessions/:id/threads/:tid", (c) => handleGetThread(c.req.raw, c.req.param("id"), c.req.param("tid")));
app.post("/anthropic/v1/sessions/:id/threads/:tid/archive", (c) => handleArchiveThread(c.req.raw, c.req.param("id"), c.req.param("tid")));
app.get("/anthropic/v1/sessions/:id/threads/:tid/events", (c) => handleListThreadEvents(c.req.raw, c.req.param("id"), c.req.param("tid")));
app.get("/anthropic/v1/sessions/:id/threads/:tid/stream", (c) => handleStreamThreadEvents(c.req.raw, c.req.param("id"), c.req.param("tid")));

// ── Vaults ───────────────────────────────────────────────────────────────
app.post("/anthropic/v1/vaults", (c) => handleCreateVault(c.req.raw));
app.get("/anthropic/v1/vaults", (c) => handleListVaults(c.req.raw));
// Sub-resource routes must be registered BEFORE the generic :id routes
app.post("/anthropic/v1/vaults/:id/archive", (c) => handleArchiveVault(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/vaults/:id", (c) => handleGetVault(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/vaults/:id", (c) => handleUpdateVault(c.req.raw, c.req.param("id")));
app.delete("/anthropic/v1/vaults/:id", (c) => handleDeleteVault(c.req.raw, c.req.param("id")));

// Vault credentials (Anthropic-compatible) — registered BEFORE :key routes
app.post("/anthropic/v1/vaults/:id/credentials", (c) => handleCreateCredential(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/vaults/:id/credentials", (c) => handleListCredentials(c.req.raw, c.req.param("id")));
// Sub-resource routes must be registered BEFORE the generic :credId routes
app.post("/anthropic/v1/vaults/:id/credentials/:credId/archive", (c) => handleArchiveCredential(c.req.raw, c.req.param("id"), c.req.param("credId")));
app.get("/anthropic/v1/vaults/:id/credentials/:credId", (c) => handleGetCredential(c.req.raw, c.req.param("id"), c.req.param("credId")));
app.post("/anthropic/v1/vaults/:id/credentials/:credId", (c) => handleUpdateCredential(c.req.raw, c.req.param("id"), c.req.param("credId")));
app.delete("/anthropic/v1/vaults/:id/credentials/:credId", (c) => handleDeleteCredential(c.req.raw, c.req.param("id"), c.req.param("credId")));

// Vault entries
app.get("/anthropic/v1/vaults/:id/entries", (c) => handleListEntries(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/vaults/:id/entries/:key", (c) => handleGetEntry(c.req.raw, c.req.param("id"), c.req.param("key")));
app.put("/anthropic/v1/vaults/:id/entries/:key", (c) => handlePutEntry(c.req.raw, c.req.param("id"), c.req.param("key")));
app.delete("/anthropic/v1/vaults/:id/entries/:key", (c) => handleDeleteEntry(c.req.raw, c.req.param("id"), c.req.param("key")));

// ── Memory Stores ────────────────────────────────────────────────────────
// CMA-canonical: under /anthropic/v1/*. The `/dream` consolidation
// endpoint is an AgentStep-only extension and stays under /v1/*
// (reachable as /agentstep/v1/memory_stores/:id/dream via the
// canonical-surface catch-all forwarder).
app.post("/anthropic/v1/memory_stores", (c) => handleCreateMemoryStore(c.req.raw));
app.get("/anthropic/v1/memory_stores", (c) => handleListMemoryStores(c.req.raw));
// Sub-resource routes must be registered BEFORE the generic :id routes
app.post("/anthropic/v1/memory_stores/:id/archive", (c) => handleArchiveMemoryStore(c.req.raw, c.req.param("id")));
app.post("/v1/memory_stores/:id/dream", (c) => handleDreamMemoryStore(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/memory_stores/:id/memory_versions", (c) => handleListMemoryVersions(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/memory_stores/:id/memory_versions/:vid", (c) => handleGetMemoryVersion(c.req.raw, c.req.param("id"), c.req.param("vid")));
app.post("/anthropic/v1/memory_stores/:id/memory_versions/:vid/redact", (c) => handleRedactMemoryVersion(c.req.raw, c.req.param("id"), c.req.param("vid")));
app.get("/anthropic/v1/memory_stores/:id", (c) => handleGetMemoryStore(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/memory_stores/:id", (c) => handleUpdateMemoryStore(c.req.raw, c.req.param("id")));
app.delete("/anthropic/v1/memory_stores/:id", (c) => handleDeleteMemoryStore(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/memory_stores/:id/memories", (c) => handleCreateMemory(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/memory_stores/:id/memories", (c) => handleListMemories(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/memory_stores/:id/memories/:memId", (c) => handleGetMemory(c.req.raw, c.req.param("id"), c.req.param("memId")));
app.post("/anthropic/v1/memory_stores/:id/memories/:memId", (c) => handleUpdateMemory(c.req.raw, c.req.param("id"), c.req.param("memId")));
app.patch("/anthropic/v1/memory_stores/:id/memories/:memId", (c) => handleUpdateMemory(c.req.raw, c.req.param("id"), c.req.param("memId")));
app.delete("/anthropic/v1/memory_stores/:id/memories/:memId", (c) => handleDeleteMemory(c.req.raw, c.req.param("id"), c.req.param("memId")));

// ── Settings ─────────────────────────────────────────────────────────────
app.put("/v1/settings", (c) => handlePutSetting(c.req.raw));
app.get("/v1/settings/:key", (c) => handleGetSetting(c.req.raw, c.req.param("key")));

// ── Providers ─────────────────────────────────────────────────────────────
app.get("/v1/providers/status", (c) => handleGetProviderStatus(c.req.raw));

// ── Models ───────────────────────────────────────────────────────────────
// CMA-canonical (PR9). Anthropic SDK exposes `GET /v1/models` on the
// Managed Agents API surface.
app.get("/anthropic/v1/models", (c) => handleListModels(c.req.raw));

// ── Skills ────────────────────────────────────────────────────────────
// CMA-canonical CRUD goes under /anthropic/v1/* (PR9). The
// catalog/feed/index/sources/stats discovery extensions are
// AgentStep-only and stay under /v1/* (reachable as
// /agentstep/v1/skills/{...} via the canonical-surface catch-all).
//
// Catalog/search routes (our extensions) — registered first to avoid shadowing
app.get("/v1/skills/catalog", (c) => handleGetSkillsCatalog(c.req.raw));
app.get("/v1/skills/stats", (c) => handleGetSkillsStats(c.req.raw));
app.get("/v1/skills/sources", (c) => handleGetSkillsSources(c.req.raw));
app.get("/v1/skills/index", (c) => handleGetSkillsIndex(c.req.raw));
app.get("/v1/skills/feed", (c) => handleGetSkillsFeed(c.req.raw));
// CRUD + versioning routes — versioned routes before :id to avoid shadowing
// Content download must be before the generic :version route to avoid shadowing
app.get("/anthropic/v1/skills/:id/versions/:version/content", (c) =>
  handleGetSkillVersionContent(c.req.raw, c.req.param("id"), c.req.param("version")));
app.get("/anthropic/v1/skills/:id/versions/:version", (c) => handleGetSkillVersion(c.req.raw, c.req.param("id"), c.req.param("version")));
app.delete("/anthropic/v1/skills/:id/versions/:version", (c) => handleDeleteSkillVersion(c.req.raw, c.req.param("id"), c.req.param("version")));
app.post("/anthropic/v1/skills/:id/versions", (c) => handleCreateSkillVersion(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/skills/:id/versions", (c) => handleListSkillVersions(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/skills", (c) => handleCreateSkill(c.req.raw));
app.get("/anthropic/v1/skills/:id", (c) => handleGetSkill(c.req.raw, c.req.param("id")));
// Anthropic Managed Agents convention: GET /v1/skills returns the
// caller's uploaded skills. Community catalog search lives at
// /v1/skills/catalog (mounted above). Kept handleSearchSkills imported
// because the CLI's LocalBackend (packages/gateway/src/backend/local.ts)
// still calls it directly with query params for its `skills search`
// command — semantically a community-catalog search, not a list.
app.get("/anthropic/v1/skills", (c) => handleListSkills(c.req.raw));
app.delete("/anthropic/v1/skills/:id", (c) => handleDeleteSkill(c.req.raw, c.req.param("id")));

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

// ── Virtual keys (admin-only) ──────────────────────────────────────────────
app.post("/v1/api-keys", (c) => handleCreateApiKey(c.req.raw));
app.get("/v1/api-keys", (c) => handleListApiKeys(c.req.raw));
// :id/activity before :id so the more-specific route doesn't get shadowed.
app.get("/v1/api-keys/:id/activity", (c) => handleGetApiKeyActivity(c.req.raw, c.req.param("id")));
app.get("/v1/api-keys/:id", (c) => handleGetApiKey(c.req.raw, c.req.param("id")));
app.patch("/v1/api-keys/:id", (c) => handlePatchApiKey(c.req.raw, c.req.param("id")));
app.delete("/v1/api-keys/:id", (c) => handleRevokeApiKey(c.req.raw, c.req.param("id")));

// ── Upstream-key pool (admin-only) ─────────────────────────────────────────
app.post("/v1/upstream-keys", (c) => handleAddUpstreamKey(c.req.raw));
app.get("/v1/upstream-keys", (c) => handleListUpstreamKeys(c.req.raw));
app.get("/v1/upstream-keys/:id", (c) => handleGetUpstreamKey(c.req.raw, c.req.param("id")));
app.patch("/v1/upstream-keys/:id", (c) => handlePatchUpstreamKey(c.req.raw, c.req.param("id")));
app.delete("/v1/upstream-keys/:id", (c) => handleDeleteUpstreamKey(c.req.raw, c.req.param("id")));

// ── Whoami (caller identity, any authenticated key) ─────────────────────────
app.get("/v1/whoami", (c) => handleWhoami(c.req.raw));

// ── License (public — returns plan + feature list, never the key) ────────────
app.get("/v1/license", (c) => handleGetLicense(c.req.raw));

// ── Audit log (admin-only, tenant-scoped) ────────────────────────────────────
app.get("/v1/audit-log", (c) => handleListAudit(c.req.raw));

// ── Tenants (global-admin only) ────────────────────────────────────────────
app.post("/v1/tenants", (c) => handleCreateTenant(c.req.raw));
app.get("/v1/tenants", (c) => handleListTenants(c.req.raw));
app.get("/v1/tenants/:id", (c) => handleGetTenant(c.req.raw, c.req.param("id")));
app.patch("/v1/tenants/:id", (c) => handlePatchTenant(c.req.raw, c.req.param("id")));
app.delete("/v1/tenants/:id", (c) => handleArchiveTenant(c.req.raw, c.req.param("id")));

// ── 501 stubs: enterprise-only features ─────────────────────────────────────
const notImplemented = (feature: string) => (c: Context) =>
  c.json({ type: "error", error: { type: "not_implemented", message: `${feature} is an Anthropic-hosted feature and is not available on self-hosted gateways.` } }, 501);

app.post("/anthropic/v1/user_profiles", (c) => handleCreateUserProfile(c.req.raw));
app.get("/anthropic/v1/user_profiles", (c) => handleListUserProfiles(c.req.raw));
app.get("/anthropic/v1/user_profiles/:id", (c) => handleGetUserProfile(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/user_profiles/:id", (c) => handleUpdateUserProfile(c.req.raw, c.req.param("id")));
app.post("/anthropic/v1/user_profiles/:id/enrollment_url", (c) => handleEnrollmentUrl(c.req.raw, c.req.param("id")));
app.get("/anthropic/v1/oauth/callback", (c) => handleOAuthCallback(c.req.raw));
app.post("/anthropic/v1/vaults/:id/credentials/:credId/mcp_oauth_validate", (c) => handleMcpOauthValidate(c.req.raw, c.req.param("id"), c.req.param("credId")));

// ── Google Interactions API compat ───────────────────────────────────────────
// Auth header translation: x-goog-api-key -> x-api-key
app.use("/google/v1beta/*", async (c, next) => {
  const googKey = c.req.header("x-goog-api-key");
  if (googKey && !c.req.header("x-api-key")) {
    c.req.raw.headers.set("x-api-key", googKey);
  }
  await next();
});
app.post("/google/v1beta/interactions", (c) => handleCreateInteraction(c.req.raw));
app.get("/google/v1beta/interactions/:id", (c) => handleGetInteraction(c.req.raw, c.req.param("id")));
app.delete("/google/v1beta/interactions/:id", (c) => handleDeleteInteraction(c.req.raw, c.req.param("id")));
app.post("/google/v1beta/interactions/:id/cancel", (c) => handleCancelInteraction(c.req.raw, c.req.param("id")));
app.post("/google/v1beta/agents", (c) => handleCreateGoogleAgent(c.req.raw));
app.get("/google/v1beta/agents", (c) => handleListGoogleAgents(c.req.raw));
app.get("/google/v1beta/agents/:id", (c) => handleGetGoogleAgent(c.req.raw, c.req.param("id")));
app.delete("/google/v1beta/agents/:id", (c) => handleDeleteGoogleAgent(c.req.raw, c.req.param("id")));
app.get("/google/v1beta/files/:fileRef", (c) => handleGetEnvironmentFiles(c.req.raw, c.req.param("fileRef")));

// ── SPA catch-all (must be last) ────────────────────────────────────────────
app.get("*", (c) => {
  const path = c.req.path;
  if (path === "/v1" || path.startsWith("/v1/") || path === "/anthropic/v1" || path.startsWith("/anthropic/v1/") || path === "/api" || path.startsWith("/api/")) {
    return c.json({ error: { type: "not_found_error", message: "Not found" } }, 404);
  }
  return serveUI(c);
});

export default app;
