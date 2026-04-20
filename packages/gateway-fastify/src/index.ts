/**
 * @agentstep/gateway-fastify — Fastify adapter for the Managed Agents API.
 *
 * All business logic lives in @agentstep/agent-sdk. This file registers
 * routes and delegates to core handler functions.
 *
 * Core handlers use the Web API Request/Response interface. Fastify uses
 * its own req/reply objects, so we convert between them.
 */
import Fastify from "fastify";
import {
  handleCreateAgent,
  handleListAgents,
  handleGetAgent,
  handleUpdateAgent,
  handleDeleteAgent,
  handleCreateEnvironment,
  handleListEnvironments,
  handleGetEnvironment,
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
  prepareSessionStream,
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
  handleDeleteSkill,
  handleCreateCredential,
  handleListCredentials,
  handleGetCredential,
  handleUpdateCredential,
  handleDeleteCredential,
} from "@agentstep/agent-sdk/handlers";

/**
 * Convert a Fastify request to a Web API Request.
 */
function toWebRequest(req: import("fastify").FastifyRequest): Request {
  const url = `${req.protocol}://${req.hostname}${req.url}`;
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
  }
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = JSON.stringify(req.body);
  }
  return new Request(url, init);
}

/**
 * Send a Web API Response back through Fastify.
 */
async function sendWebResponse(
  reply: import("fastify").FastifyReply,
  response: Response,
): Promise<void> {
  reply.status(response.status);
  response.headers.forEach((val, key) => reply.header(key, val));

  if (response.body) {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      // SSE — pipe the ReadableStream
      reply.header("content-type", "text/event-stream");
      reply.header("cache-control", "no-cache");
      reply.header("connection", "keep-alive");
      const reader = response.body.getReader();
      reply.raw.writeHead(response.status, Object.fromEntries(response.headers));
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          reply.raw.write(value);
        }
        reply.raw.end();
      };
      pump();
      return;
    }
    reply.send(await response.text());
  } else {
    reply.send("");
  }
}

type Handler = (req: Request, ...args: string[]) => Response | Promise<Response>;

function route(
  app: import("fastify").FastifyInstance,
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  handler: Handler,
  ...paramNames: string[]
) {
  app[method](path, async (req, reply) => {
    const webReq = toWebRequest(req);
    const params = paramNames.map((p) => (req.params as Record<string, string>)[p]);
    const response = await handler(webReq, ...params);
    await sendWebResponse(reply, response);
  });
}

/**
 * Only inject the API key into HTML for requests from the loopback
 * interface. When the server is bound publicly, the key must not be
 * returned to arbitrary LAN clients. The UI will fall back to
 * localStorage / manual paste.
 *
 * Reverse-proxy deployments (same-host Caddy/Nginx) will see the
 * socket as 127.0.0.1 always, which would otherwise leak the key to
 * public clients. Require TRUST_PROXY=1 to honor X-Forwarded-For.
 */
function isLoopbackFastifyRequest(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
}): boolean {
  const trustProxy = process.env.TRUST_PROXY === "1";
  if (trustProxy) {
    const h = req.headers ?? {};
    const xff = h["x-forwarded-for"];
    const xri = h["x-real-ip"];
    const first = Array.isArray(xff) ? xff[0] : xff;
    const realIp = Array.isArray(xri) ? xri[0] : xri;
    const proxied = (typeof first === "string" ? first.split(",")[0]?.trim() : undefined) ?? realIp;
    if (typeof proxied === "string" && proxied) {
      const addr = proxied.replace(/^::ffff:/, "");
      return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
    }
  }
  const raw = req.ip ?? req.socket?.remoteAddress ?? "";
  const addr = raw.replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

export function buildApp() {
  const app = Fastify({ logger: false });

  // ── Built-in Web UI ──────────────────────────────────────────────────
  app.get("/", async (req, reply) => {
    const response = await handleGetUI({
      apiKey: isLoopbackFastifyRequest({ ip: req.ip, socket: req.socket, headers: req.headers }) ? process.env.SEED_API_KEY : undefined,
    });
    await sendWebResponse(reply, response);
  });

  // ── Health ───────────────────────────────────────────────────────────
  app.get("/api/health", async (_req, reply) => reply.send({ status: "ok" }));

  // ── OpenAPI ──────────────────────────────────────────────────────────
  route(app, "get", "/v1/openapi.json", handleGetOpenApiSpec);
  app.get("/v1/docs", async (_req, reply) => {
    const response = await handleGetDocs();
    await sendWebResponse(reply, response);
  });

  // ── Agents ───────────────────────────────────────────────────────────
  route(app, "post", "/v1/agents", handleCreateAgent);
  route(app, "get", "/v1/agents", handleListAgents);
  route(app, "get", "/v1/agents/:id", handleGetAgent, "id");
  route(app, "post", "/v1/agents/:id", handleUpdateAgent, "id");
  route(app, "delete", "/v1/agents/:id", handleDeleteAgent, "id");

  // ── Environments ─────────────────────────────────────────────────────
  route(app, "post", "/v1/environments", handleCreateEnvironment);
  route(app, "get", "/v1/environments", handleListEnvironments);
  route(app, "get", "/v1/environments/:id", handleGetEnvironment, "id");
  route(app, "delete", "/v1/environments/:id", handleDeleteEnvironment, "id");
  route(app, "post", "/v1/environments/:id/archive", handleArchiveEnvironment, "id");

  // ── Sessions ─────────────────────────────────────────────────────────
  route(app, "post", "/v1/sessions", handleCreateSession);
  route(app, "get", "/v1/sessions", handleListSessions);
  route(app, "get", "/v1/sessions/:id", handleGetSession, "id");
  route(app, "post", "/v1/sessions/:id", handleUpdateSession, "id");
  route(app, "delete", "/v1/sessions/:id", handleDeleteSession, "id");
  route(app, "post", "/v1/sessions/:id/archive", handleArchiveSession, "id");

  // ── Events ───────────────────────────────────────────────────────────
  route(app, "post", "/v1/sessions/:id/events", handlePostEvents, "id");
  route(app, "get", "/v1/sessions/:id/events", handleListEvents, "id");

  // ── Stream (SSE) ─────────────────────────────────────────────────────
  // Uses prepareSessionStream + reply.raw.write for proper SSE flushing.
  // The generic route() helper pipes through sendWebResponse which buffers
  // ReadableStream bodies — SSE requires immediate chunk flushing.
  app.get("/v1/sessions/:id/events/stream", async (req, reply) => {
    const { id } = req.params as { id: string };
    const prepared = await prepareSessionStream(toWebRequest(req), id);

    if (prepared instanceof Response) {
      await sendWebResponse(reply, prepared);
      return;
    }

    const { afterSeq, subscribeFn } = prepared;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const pending: Array<{ seq: number; type: string; data: string }> = [];
    const sub = subscribeFn(afterSeq, (evt) => {
      pending.push({ seq: evt.seq, type: evt.type, data: JSON.stringify(evt) });
    });

    const interval = setInterval(() => {
      while (pending.length > 0) {
        const evt = pending.shift()!;
        reply.raw.write(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${evt.data}\n\n`);
      }
      // Keepalive ping
      reply.raw.write(`data: {"type":"ping"}\n\n`);
    }, 500);

    // Drain backlog immediately
    while (pending.length > 0) {
      const evt = pending.shift()!;
      reply.raw.write(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${evt.data}\n\n`);
    }

    req.raw.on("close", () => {
      clearInterval(interval);
      sub.unsubscribe();
      reply.raw.end();
    });
  });

  // ── Threads ──────────────────────────────────────────────────────────
  route(app, "get", "/v1/sessions/:id/threads", handleListThreads, "id");

  // ── Vaults ───────────────────────────────────────────────────────────
  route(app, "post", "/v1/vaults", handleCreateVault);
  route(app, "get", "/v1/vaults", handleListVaults);
  route(app, "get", "/v1/vaults/:id", handleGetVault, "id");
  route(app, "delete", "/v1/vaults/:id", handleDeleteVault, "id");

  // Vault credentials (Anthropic-compatible) — registered BEFORE :key routes
  route(app, "post", "/v1/vaults/:id/credentials", handleCreateCredential, "id");
  route(app, "get", "/v1/vaults/:id/credentials", handleListCredentials, "id");
  app.get("/v1/vaults/:id/credentials/:credId", async (req, reply) => {
    const { id, credId } = req.params as { id: string; credId: string };
    await sendWebResponse(reply, await handleGetCredential(toWebRequest(req), id, credId));
  });
  app.post("/v1/vaults/:id/credentials/:credId", async (req, reply) => {
    const { id, credId } = req.params as { id: string; credId: string };
    await sendWebResponse(reply, await handleUpdateCredential(toWebRequest(req), id, credId));
  });
  app.delete("/v1/vaults/:id/credentials/:credId", async (req, reply) => {
    const { id, credId } = req.params as { id: string; credId: string };
    await sendWebResponse(reply, await handleDeleteCredential(toWebRequest(req), id, credId));
  });

  // Vault entries
  route(app, "get", "/v1/vaults/:id/entries", handleListEntries, "id");
  route(app, "get", "/v1/vaults/:id/entries/:key", handleGetEntry, "id", "key");
  route(app, "put", "/v1/vaults/:id/entries/:key", handlePutEntry, "id", "key");
  route(app, "delete", "/v1/vaults/:id/entries/:key", handleDeleteEntry, "id", "key");

  // ── Memory Stores ────────────────────────────────────────────────────
  route(app, "post", "/v1/memory_stores", handleCreateMemoryStore);
  route(app, "get", "/v1/memory_stores", handleListMemoryStores);
  route(app, "get", "/v1/memory_stores/:id", handleGetMemoryStore, "id");
  route(app, "delete", "/v1/memory_stores/:id", handleDeleteMemoryStore, "id");
  route(app, "post", "/v1/memory_stores/:id/memories", handleCreateMemory, "id");
  route(app, "get", "/v1/memory_stores/:id/memories", handleListMemories, "id");
  route(app, "get", "/v1/memory_stores/:id/memories/:memId", handleGetMemory, "id", "memId");
  route(app, "patch", "/v1/memory_stores/:id/memories/:memId", handleUpdateMemory, "id", "memId");
  route(app, "delete", "/v1/memory_stores/:id/memories/:memId", handleDeleteMemory, "id", "memId");

  // ── Skills (stub endpoints) ────────────────────────────────────────────
  route(app, "post", "/v1/skills", handleCreateSkill);
  route(app, "delete", "/v1/skills/:id", handleDeleteSkill, "id");

  // ── Batch ────────────────────────────────────────────────────────────
  route(app, "post", "/v1/batch", handleBatch);

  // ── Virtual keys (admin-only) ────────────────────────────────────────
  route(app, "post", "/v1/api-keys", handleCreateApiKey);
  route(app, "get", "/v1/api-keys", handleListApiKeys);
  app.get("/v1/api-keys/:id/activity", async (req, reply) => {
    const { id } = req.params as { id: string };
    const response = await handleGetApiKeyActivity(toWebRequest(req), id);
    await sendWebResponse(reply, response);
  });
  app.get("/v1/api-keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const response = await handleGetApiKey(toWebRequest(req), id);
    await sendWebResponse(reply, response);
  });
  app.patch("/v1/api-keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const response = await handlePatchApiKey(toWebRequest(req), id);
    await sendWebResponse(reply, response);
  });
  app.delete("/v1/api-keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const response = await handleRevokeApiKey(toWebRequest(req), id);
    await sendWebResponse(reply, response);
  });

  // ── Upstream-key pool (admin-only) ──────────────────────────────────
  route(app, "post", "/v1/upstream-keys", handleAddUpstreamKey);
  route(app, "get", "/v1/upstream-keys", handleListUpstreamKeys);
  app.get("/v1/upstream-keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await sendWebResponse(reply, await handleGetUpstreamKey(toWebRequest(req), id));
  });
  app.patch("/v1/upstream-keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await sendWebResponse(reply, await handlePatchUpstreamKey(toWebRequest(req), id));
  });
  app.delete("/v1/upstream-keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await sendWebResponse(reply, await handleDeleteUpstreamKey(toWebRequest(req), id));
  });

  // ── Whoami (any authenticated caller) ───────────────────────────────
  route(app, "get", "/v1/whoami", handleWhoami);

  // ── License (public — returns plan + feature list) ─────────────────
  route(app, "get", "/v1/license", handleGetLicense);

  // ── Audit log (admin-only, tenant-scoped) ───────────────────────────
  route(app, "get", "/v1/audit-log", handleListAudit);

  // ── Tenants (global-admin only) ─────────────────────────────────────
  route(app, "post", "/v1/tenants", handleCreateTenant);
  route(app, "get", "/v1/tenants", handleListTenants);
  app.get("/v1/tenants/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await sendWebResponse(reply, await handleGetTenant(toWebRequest(req), id));
  });
  app.patch("/v1/tenants/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await sendWebResponse(reply, await handlePatchTenant(toWebRequest(req), id));
  });
  app.delete("/v1/tenants/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await sendWebResponse(reply, await handleArchiveTenant(toWebRequest(req), id));
  });

  return app;
}

export default buildApp;
