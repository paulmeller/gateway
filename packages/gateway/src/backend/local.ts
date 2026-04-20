/**
 * LocalBackend — routes all operations through @agentstep/agent-sdk handler
 * functions, using the same code path as the Hono web app.
 *
 * A Request object is constructed with the right method/path/headers/body,
 * the handler is called, and the JSON response is parsed.  For SSE streams the
 * Response body is consumed directly and yielded as an AsyncGenerator.
 */
import type { Backend, Paginated } from "./interface.js";
import { initForCli } from "../lifecycle.js";

// Internal API key resolved once at init time.
let localApiKey = "";

async function resolveApiKey(): Promise<string> {
  if (localApiKey) return localApiKey;

  // Prefer the env-var that ensureInitialized() seeds on first boot.
  if (process.env.SEED_API_KEY) {
    localApiKey = process.env.SEED_API_KEY;
    return localApiKey;
  }

  // Fall back: read the first active key from the DB (raw key not stored,
  // but the prefix is — so we cannot reconstruct it this way).
  // ensureInitialized() writes the generated key to .env *and* sets
  // process.env.SEED_API_KEY only when it creates a new key from SEED_API_KEY.
  // For a freshly-generated key the value is only available at creation time.
  // Re-read .env file to pick it up if it was written during this session.
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const match = /^SEED_API_KEY=(.+)$/m.exec(content);
      if (match) {
        localApiKey = match[1].trim();
        return localApiKey;
      }
    }
  } catch {
    // best-effort
  }

  // Last resort: DB has keys but we don't have the raw key.
  // Create a new one for CLI use and persist to .env.
  try {
    const { createApiKey } = await import("@agentstep/agent-sdk");
    const { key } = createApiKey({ name: "cli", permissions: ["*"] });
    const fs = await import("node:fs");
    const pathMod = await import("node:path");
    const envPath = pathMod.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, `SEED_API_KEY=${key}\n`, "utf-8");
    } else {
      fs.appendFileSync(envPath, `\nSEED_API_KEY=${key}\n`, "utf-8");
    }
    process.env.SEED_API_KEY = key;
    localApiKey = key;
    return localApiKey;
  } catch (err) {
    console.error("[resolveApiKey] fallback key creation failed:", err);
    // fall through
  }

  throw new Error(
    "No API key available for local backend. Set SEED_API_KEY env var or let the server generate one on first run.",
  );
}

/**
 * Build a Request, call a handler, parse the JSON response.
 * Throws on non-2xx with the server's error message.
 */
async function callHandler<T = unknown>(
  handler: (req: Request, ...ids: string[]) => Promise<Response>,
  method: string,
  url: string,
  body?: unknown,
  ...ids: string[]
): Promise<T> {
  const apiKey = await resolveApiKey();
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
  };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const req = new Request(url, init);
  const res = await handler(req, ...ids);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `HTTP ${res.status}`;
    try {
      const err = JSON.parse(text) as { error?: { type?: string; message?: string } };
      if (err?.error?.message) msg = `${err.error.type ?? "error"}: ${err.error.message}`;
    } catch { /* use default msg */ }
    throw new Error(msg);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Build a localhost URL with optional query params */
function url(path: string, params?: Record<string, string | number | boolean | undefined>): string {
  const u = new URL(`http://localhost${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

// ── SSE → AsyncGenerator ──────────────────────────────────────────────────

async function* sseResponseToGenerator(res: Response): AsyncGenerator<unknown> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentData = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep the incomplete trailing line

      for (const line of lines) {
        if (line === "") {
          // Event boundary
          if (currentData) {
            try {
              const parsed = JSON.parse(currentData) as { type?: string };
              if (parsed.type !== "ping") yield parsed;
            } catch { /* skip malformed */ }
            currentData = "";
          }
        } else if (line.startsWith("data:")) {
          currentData = line.slice(5).trimStart();
        }
        // ignore id:/event: lines — we don't need them here
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ── LocalBackend ─────────────────────────────────────────────────────────

export class LocalBackend implements Backend {
  async init(): Promise<void> {
    await initForCli();
    // Resolve (and cache) the API key now so later calls are synchronous.
    await resolveApiKey();
  }

  agents = {
    async create(input: { name: string; model: string; system?: string; backend?: string; confirmation_mode?: boolean }) {
      const { handleCreateAgent } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleCreateAgent, "POST", url("/v1/agents"), input);
    },

    async list(opts?: { limit?: number; order?: string; include_archived?: boolean }): Promise<Paginated<any>> {
      const { handleListAgents } = await import("@agentstep/agent-sdk/handlers");
      return callHandler<Paginated<any>>(
        handleListAgents,
        "GET",
        url("/v1/agents", {
          limit: opts?.limit,
          order: opts?.order,
          include_archived: opts?.include_archived,
        }),
      );
    },

    async get(id: string, version?: number) {
      const { handleGetAgent } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleGetAgent, "GET", url(`/v1/agents/${id}`, { version }), undefined, id);
    },

    async update(id: string, input: Record<string, unknown>) {
      const { handleUpdateAgent } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleUpdateAgent, "POST", url(`/v1/agents/${id}`), input, id);
    },

    async delete(id: string) {
      const { handleDeleteAgent } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleDeleteAgent, "DELETE", url(`/v1/agents/${id}`), undefined, id);
    },
  };

  environments = {
    async create(input: { name: string; config: Record<string, unknown> }) {
      const { handleCreateEnvironment } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleCreateEnvironment, "POST", url("/v1/environments"), input);
    },

    async list(opts?: { limit?: number; order?: string; include_archived?: boolean }): Promise<Paginated<any>> {
      const { handleListEnvironments } = await import("@agentstep/agent-sdk/handlers");
      return callHandler<Paginated<any>>(
        handleListEnvironments,
        "GET",
        url("/v1/environments", {
          limit: opts?.limit,
          order: opts?.order,
          include_archived: opts?.include_archived,
        }),
      );
    },

    async get(id: string) {
      const { handleGetEnvironment } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleGetEnvironment, "GET", url(`/v1/environments/${id}`), undefined, id);
    },

    async delete(id: string) {
      const { handleDeleteEnvironment } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleDeleteEnvironment, "DELETE", url(`/v1/environments/${id}`), undefined, id);
    },

    async archive(id: string) {
      const { handleArchiveEnvironment } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleArchiveEnvironment, "POST", url(`/v1/environments/${id}/archive`), undefined, id);
    },
  };

  sessions = {
    async create(input: { agent: string | { id: string; version: number; type?: string }; environment_id: string; title?: string; max_budget_usd?: number }) {
      const { handleCreateSession } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleCreateSession, "POST", url("/v1/sessions"), input);
    },

    async list(opts?: { limit?: number; order?: string; agent_id?: string; environment_id?: string; status?: string; include_archived?: boolean }): Promise<Paginated<any>> {
      const { handleListSessions } = await import("@agentstep/agent-sdk/handlers");
      return callHandler<Paginated<any>>(
        handleListSessions,
        "GET",
        url("/v1/sessions", {
          limit: opts?.limit,
          order: opts?.order,
          agent_id: opts?.agent_id,
          environment_id: opts?.environment_id,
          status: opts?.status,
          include_archived: opts?.include_archived,
        }),
      );
    },

    async get(id: string) {
      const { handleGetSession } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleGetSession, "GET", url(`/v1/sessions/${id}`), undefined, id);
    },

    async update(id: string, input: Record<string, unknown>) {
      const { handleUpdateSession } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleUpdateSession, "POST", url(`/v1/sessions/${id}`), input, id);
    },

    async delete(id: string) {
      const { handleDeleteSession } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleDeleteSession, "DELETE", url(`/v1/sessions/${id}`), undefined, id);
    },

    async archive(id: string) {
      const { handleArchiveSession } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleArchiveSession, "POST", url(`/v1/sessions/${id}/archive`), undefined, id);
    },

    async threads(id: string, opts?: { limit?: number }): Promise<Paginated<any>> {
      const { handleListThreads } = await import("@agentstep/agent-sdk/handlers");
      return callHandler<Paginated<any>>(
        handleListThreads,
        "GET",
        url(`/v1/sessions/${id}/threads`, { limit: opts?.limit }),
        undefined,
        id,
      );
    },
  };

  events = {
    async send(sessionId: string, events: Array<Record<string, unknown>>) {
      const { handlePostEvents } = await import("@agentstep/agent-sdk/handlers");
      return callHandler<{ events: any[] }>(
        handlePostEvents,
        "POST",
        url(`/v1/sessions/${sessionId}/events`),
        { events },
        sessionId,
      );
    },

    async list(sessionId: string, opts?: { limit?: number; order?: string; after_seq?: number }): Promise<Paginated<any>> {
      const { handleListEvents } = await import("@agentstep/agent-sdk/handlers");
      return callHandler<Paginated<any>>(
        handleListEvents,
        "GET",
        url(`/v1/sessions/${sessionId}/events`, {
          limit: opts?.limit,
          order: opts?.order,
          after_seq: opts?.after_seq,
        }),
        undefined,
        sessionId,
      );
    },

    async *stream(sessionId: string, afterSeq?: number): AsyncGenerator<any> {
      const { handleSessionStream } = await import("@agentstep/agent-sdk/handlers");
      const apiKey = await resolveApiKey();
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        "x-api-key": apiKey,
      };
      if (afterSeq != null) {
        headers["Last-Event-ID"] = String(afterSeq);
      }
      const req = new Request(
        url(`/v1/sessions/${sessionId}/events/stream`, afterSeq != null ? { after_seq: afterSeq } : undefined),
        { headers },
      );
      const res = await handleSessionStream(req, sessionId);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`stream failed: HTTP ${res.status} ${text}`);
      }
      yield* sseResponseToGenerator(res);
    },
  };

  vaults = {
    async create(input: { agent_id: string; name: string }) {
      const { handleCreateVault } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleCreateVault, "POST", url("/v1/vaults"), input);
    },

    async list(opts?: { agent_id?: string }) {
      const { handleListVaults } = await import("@agentstep/agent-sdk/handlers");
      return callHandler<{ data: any[] }>(
        handleListVaults,
        "GET",
        url("/v1/vaults", { agent_id: opts?.agent_id }),
      );
    },

    async get(id: string) {
      const { handleGetVault } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleGetVault, "GET", url(`/v1/vaults/${id}`), undefined, id);
    },

    async delete(id: string) {
      const { handleDeleteVault } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleDeleteVault, "DELETE", url(`/v1/vaults/${id}`), undefined, id);
    },

    entries: {
      async list(vaultId: string) {
        const { handleListEntries } = await import("@agentstep/agent-sdk/handlers");
        return callHandler<{ data: any[] }>(
          handleListEntries,
          "GET",
          url(`/v1/vaults/${vaultId}/entries`),
          undefined,
          vaultId,
        );
      },

      async get(vaultId: string, key: string) {
        const { handleGetEntry } = await import("@agentstep/agent-sdk/handlers");
        return callHandler(
          handleGetEntry,
          "GET",
          url(`/v1/vaults/${vaultId}/entries/${encodeURIComponent(key)}`),
          undefined,
          vaultId,
          key,
        );
      },

      async set(vaultId: string, key: string, value: string) {
        const { handlePutEntry } = await import("@agentstep/agent-sdk/handlers");
        return callHandler(
          handlePutEntry,
          "PUT",
          url(`/v1/vaults/${vaultId}/entries/${encodeURIComponent(key)}`),
          { value },
          vaultId,
          key,
        );
      },

      async delete(vaultId: string, key: string) {
        const { handleDeleteEntry } = await import("@agentstep/agent-sdk/handlers");
        return callHandler(
          handleDeleteEntry,
          "DELETE",
          url(`/v1/vaults/${vaultId}/entries/${encodeURIComponent(key)}`),
          undefined,
          vaultId,
          key,
        );
      },
    },
  };

  memory = {
    stores: {
      async create(input: { name: string; description?: string }) {
        const { handleCreateMemoryStore } = await import("@agentstep/agent-sdk/handlers");
        return callHandler(handleCreateMemoryStore, "POST", url("/v1/memory_stores"), input);
      },

      async list() {
        const { handleListMemoryStores } = await import("@agentstep/agent-sdk/handlers");
        return callHandler<{ data: any[] }>(handleListMemoryStores, "GET", url("/v1/memory_stores"));
      },

      async get(id: string) {
        const { handleGetMemoryStore } = await import("@agentstep/agent-sdk/handlers");
        return callHandler(handleGetMemoryStore, "GET", url(`/v1/memory_stores/${id}`), undefined, id);
      },

      async delete(id: string) {
        const { handleDeleteMemoryStore } = await import("@agentstep/agent-sdk/handlers");
        return callHandler(handleDeleteMemoryStore, "DELETE", url(`/v1/memory_stores/${id}`), undefined, id);
      },
    },

    memories: {
      async create(storeId: string, input: { path: string; content: string }) {
        const { handleCreateMemory } = await import("@agentstep/agent-sdk/handlers");
        return callHandler(handleCreateMemory, "POST", url(`/v1/memory_stores/${storeId}/memories`), input, storeId);
      },

      async list(storeId: string) {
        const { handleListMemories } = await import("@agentstep/agent-sdk/handlers");
        return callHandler<{ data: any[] }>(
          handleListMemories,
          "GET",
          url(`/v1/memory_stores/${storeId}/memories`),
          undefined,
          storeId,
        );
      },

      async get(storeId: string, memId: string) {
        const { handleGetMemory } = await import("@agentstep/agent-sdk/handlers");
        return callHandler(
          handleGetMemory,
          "GET",
          url(`/v1/memory_stores/${storeId}/memories/${memId}`),
          undefined,
          storeId,
          memId,
        );
      },

      async update(storeId: string, memId: string, input: { content: string; content_sha256?: string }) {
        const { handleUpdateMemory } = await import("@agentstep/agent-sdk/handlers");
        return callHandler(
          handleUpdateMemory,
          "POST",
          url(`/v1/memory_stores/${storeId}/memories/${memId}`),
          input,
          storeId,
          memId,
        );
      },

      async delete(storeId: string, memId: string) {
        const { handleDeleteMemory } = await import("@agentstep/agent-sdk/handlers");
        return callHandler(
          handleDeleteMemory,
          "DELETE",
          url(`/v1/memory_stores/${storeId}/memories/${memId}`),
          undefined,
          storeId,
          memId,
        );
      },
    },
  };

  batch = {
    async execute(operations: Array<{ method: string; path: string; body?: unknown }>) {
      const { handleBatch } = await import("@agentstep/agent-sdk/handlers");
      return callHandler<{ results: Array<{ status: number; body: unknown }> }>(
        handleBatch,
        "POST",
        url("/v1/batch"),
        { operations },
      );
    },
  };

  skills = {
    async search(opts: { q?: string; sort?: string; limit?: number; offset?: number; source?: string }) {
      const { handleSearchSkills } = await import("@agentstep/agent-sdk/handlers");
      const params = new URLSearchParams();
      if (opts.q) params.set("q", opts.q);
      if (opts.sort) params.set("sort", opts.sort);
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.offset) params.set("offset", String(opts.offset));
      if (opts.source) params.set("source", opts.source);
      return callHandler(handleSearchSkills, "GET", url(`/v1/skills?${params}`));
    },
    async stats() {
      const { handleGetSkillsStats } = await import("@agentstep/agent-sdk/handlers");
      return callHandler(handleGetSkillsStats, "GET", url("/v1/skills/stats"));
    },
    async sources(opts?: { limit?: number }) {
      const { handleGetSkillsSources } = await import("@agentstep/agent-sdk/handlers");
      const params = opts?.limit ? `?limit=${opts.limit}` : "";
      return callHandler(handleGetSkillsSources, "GET", url(`/v1/skills/sources${params}`));
    },
  };

  providers = {
    async status() {
      const { handleGetProviderStatus } = await import("@agentstep/agent-sdk/handlers");
      const res = await callHandler<{ data: Record<string, { available: boolean; message?: string }> }>(
        handleGetProviderStatus, "GET", url("/v1/providers/status"),
      );
      return res.data;
    },
  };
}
