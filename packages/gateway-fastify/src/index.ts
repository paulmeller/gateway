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
 */
function isLoopbackFastifyRequest(req: { ip?: string; socket?: { remoteAddress?: string } }): boolean {
  const raw = req.ip ?? req.socket?.remoteAddress ?? "";
  const addr = raw.replace(/^::ffff:/, "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost";
}

export function buildApp() {
  const app = Fastify({ logger: false });

  // ── Built-in Web UI ──────────────────────────────────────────────────
  app.get("/", async (req, reply) => {
    const response = await handleGetUI({
      apiKey: isLoopbackFastifyRequest(req) ? process.env.SEED_API_KEY : undefined,
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
  route(app, "get", "/v1/sessions/:id/stream", handleSessionStream, "id");

  // ── Threads ──────────────────────────────────────────────────────────
  route(app, "get", "/v1/sessions/:id/threads", handleListThreads, "id");

  // ── Vaults ───────────────────────────────────────────────────────────
  route(app, "post", "/v1/vaults", handleCreateVault);
  route(app, "get", "/v1/vaults", handleListVaults);
  route(app, "get", "/v1/vaults/:id", handleGetVault, "id");
  route(app, "delete", "/v1/vaults/:id", handleDeleteVault, "id");
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

  // ── Batch ────────────────────────────────────────────────────────────
  route(app, "post", "/v1/batch", handleBatch);

  return app;
}

export default buildApp;
