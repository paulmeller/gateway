// @ts-nocheck — test file with loose typing on handler responses
/**
 * Memory mount + versions tests.
 *
 * Tests covering:
 * - Memory version creation on create/update/delete
 * - Version listing with pagination
 * - `memory_store` resource accepted on session create
 * - Archive memory store
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-mem-mount-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  delete g.__caActors;
}

async function bootDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb(); // triggers migrations
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-12345" });
  return key;
}

function req(
  url: string,
  opts: { method?: string; body?: unknown; apiKey?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.apiKey !== undefined) {
    if (opts.apiKey !== "") headers["x-api-key"] = opts.apiKey;
  } else {
    headers["x-api-key"] = "test-api-key-12345";
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function createTestAgent(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");
  const res = await handleCreateAgent(
    req("/anthropic/v1/agents", {
      body: { name: `Agent-${Date.now()}-${Math.random()}`, model: { id: "claude-sonnet-4-6" }, ...overrides },
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

async function createTestEnv(): Promise<Record<string, unknown>> {
  const { getDb } = await import("../src/db/client");
  const { newId } = await import("../src/util/ids");
  const { nowMs, toIso } = await import("../src/util/clock");

  const db = getDb();
  const id = newId("env");
  const now = nowMs();
  const config = { type: "self_hosted", provider: "docker" };

  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at, updated_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?, ?)`,
  ).run(id, `env-${Date.now()}`, JSON.stringify(config), now, now);

  return { id, name: `env-${Date.now()}`, config, state: "ready" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory mount + versions", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  // ── Version tracking ──────────────────────────────────────────────────

  describe("version tracking", () => {
    it("creates a version on createOrUpsertMemory (create)", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory, listMemoryVersions } = await import("../src/db/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      createOrUpsertMemory(store.id, "notes.md", "hello world");

      const versions = listMemoryVersions(store.id);
      expect(versions).toHaveLength(1);
      expect(versions[0].operation).toBe("create");
      expect(versions[0].path).toBe("notes.md");
      expect(versions[0].content).toBe("hello world");
      expect(versions[0].type).toBe("memory_version");
      expect(versions[0].memory_store_id).toBe(store.id);
    });

    it("creates a version on createOrUpsertMemory (update)", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory, listMemoryVersions } = await import("../src/db/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      createOrUpsertMemory(store.id, "notes.md", "v1");
      createOrUpsertMemory(store.id, "notes.md", "v2");

      const versions = listMemoryVersions(store.id);
      expect(versions).toHaveLength(2);
      const ops = versions.map(v => v.operation).sort();
      expect(ops).toEqual(["create", "update"]);
      const createVer = versions.find(v => v.operation === "create")!;
      const updateVer = versions.find(v => v.operation === "update")!;
      expect(createVer.content).toBe("v1");
      expect(updateVer.content).toBe("v2");
    });

    it("creates a version on updateMemory", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory, updateMemory, listMemoryVersions } = await import("../src/db/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      const mem = createOrUpsertMemory(store.id, "file.txt", "original");
      updateMemory(mem.id, "updated");

      const versions = listMemoryVersions(store.id);
      expect(versions).toHaveLength(2);
      const ops = versions.map(v => v.operation).sort();
      expect(ops).toEqual(["create", "update"]);
      const updateVer = versions.find(v => v.operation === "update")!;
      expect(updateVer.content).toBe("updated");
    });

    it("creates a version on deleteMemory", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory, deleteMemory, listMemoryVersions } = await import("../src/db/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      const mem = createOrUpsertMemory(store.id, "file.txt", "content");
      deleteMemory(mem.id);

      const versions = listMemoryVersions(store.id);
      expect(versions).toHaveLength(2);
      const ops = versions.map(v => v.operation).sort();
      expect(ops).toEqual(["create", "delete"]);
      const deleteVer = versions.find(v => v.operation === "delete")!;
      expect(deleteVer.path).toBe("file.txt");
    });

    it("tracks session_id when provided", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory, listMemoryVersions } = await import("../src/db/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      createOrUpsertMemory(store.id, "file.txt", "content", "sesn_test123");

      const versions = listMemoryVersions(store.id);
      expect(versions[0].session_id).toBe("sesn_test123");
    });
  });

  // ── Version listing + pagination ──────────────────────────────────────

  describe("version listing", () => {
    it("lists versions with memory_id filter", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory, listMemoryVersions } = await import("../src/db/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      const mem1 = createOrUpsertMemory(store.id, "a.txt", "a");
      createOrUpsertMemory(store.id, "b.txt", "b");

      const allVersions = listMemoryVersions(store.id);
      expect(allVersions).toHaveLength(2);

      const filtered = listMemoryVersions(store.id, { memoryId: mem1.id });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].memory_id).toBe(mem1.id);
    });

    it("paginates versions with limit", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory, listMemoryVersions } = await import("../src/db/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      createOrUpsertMemory(store.id, "a.txt", "a");
      createOrUpsertMemory(store.id, "b.txt", "b");
      createOrUpsertMemory(store.id, "c.txt", "c");

      // All 3 versions
      const all = listMemoryVersions(store.id);
      expect(all).toHaveLength(3);

      // Limit to 2
      const page1 = listMemoryVersions(store.id, { limit: 2 });
      expect(page1).toHaveLength(2);

      // Remaining 1 — use the last id from page 1 as cursor
      const page2 = listMemoryVersions(store.id, { limit: 10, cursor: page1[page1.length - 1].id });
      expect(page2).toHaveLength(1);
      // The cursor-filtered result should not include any page1 items
      const page1Ids = new Set(page1.map(v => v.id));
      for (const v of page2) {
        expect(page1Ids.has(v.id)).toBe(false);
      }
    });

    it("getMemoryVersion returns single version", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory, listMemoryVersions, getMemoryVersion } = await import("../src/db/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      createOrUpsertMemory(store.id, "file.txt", "hello");

      const versions = listMemoryVersions(store.id);
      const version = getMemoryVersion(store.id, versions[0].id);
      expect(version).toBeDefined();
      expect(version!.id).toBe(versions[0].id);
      expect(version!.path).toBe("file.txt");
    });

    it("getMemoryVersion returns undefined for wrong store", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory, listMemoryVersions, getMemoryVersion } = await import("../src/db/memory");
      const agent = await createTestAgent();

      const store1 = createMemoryStore({ name: "store1", agent_id: agent.id as string });
      const store2 = createMemoryStore({ name: "store2", agent_id: agent.id as string });
      createOrUpsertMemory(store1.id, "file.txt", "hello");

      const versions = listMemoryVersions(store1.id);
      const version = getMemoryVersion(store2.id, versions[0].id);
      expect(version).toBeUndefined();
    });
  });

  // ── Version handlers ──────────────────────────────────────────────────

  describe("version handlers", () => {
    it("GET /v1/memory_stores/:id/memory_versions lists versions", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory } = await import("../src/db/memory");
      const { handleListMemoryVersions } = await import("../src/handlers/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      createOrUpsertMemory(store.id, "file.txt", "hello");
      createOrUpsertMemory(store.id, "file.txt", "updated");

      const res = await handleListMemoryVersions(
        req(`/v1/memory_stores/${store.id}/memory_versions`),
        store.id,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });

    it("GET /v1/memory_stores/:id/memory_versions/:vid returns single version", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory, listMemoryVersions } = await import("../src/db/memory");
      const { handleGetMemoryVersion } = await import("../src/handlers/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      createOrUpsertMemory(store.id, "file.txt", "hello");

      const versions = listMemoryVersions(store.id);
      const res = await handleGetMemoryVersion(
        req(`/v1/memory_stores/${store.id}/memory_versions/${versions[0].id}`),
        store.id,
        versions[0].id,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(versions[0].id);
    });

    it("GET /v1/memory_stores/:id/memory_versions/:vid 404 for unknown", async () => {
      await bootDb();
      const { createMemoryStore } = await import("../src/db/memory");
      const { handleGetMemoryVersion } = await import("../src/handlers/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      const res = await handleGetMemoryVersion(
        req(`/v1/memory_stores/${store.id}/memory_versions/memver_NONEXISTENT`),
        store.id,
        "memver_NONEXISTENT",
      );
      expect(res.status).toBe(404);
    });
  });

  // ── Archive memory store ──────────────────────────────────────────────

  describe("archive memory store", () => {
    it("POST /v1/memory_stores/:id/archive sets archived_at", async () => {
      await bootDb();
      const { createMemoryStore, getMemoryStore } = await import("../src/db/memory");
      const { handleArchiveMemoryStore } = await import("../src/handlers/memory");
      const agent = await createTestAgent();

      const store = createMemoryStore({ name: "test-store", agent_id: agent.id as string });
      expect(store.archived_at).toBeNull();

      const res = await handleArchiveMemoryStore(
        req(`/v1/memory_stores/${store.id}/archive`, { method: "POST", body: {} }),
        store.id,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.archived_at).toBeTruthy();

      const refreshed = getMemoryStore(store.id);
      expect(refreshed!.archived_at).toBeTruthy();
    });

    it("archiving non-existent store returns 404", async () => {
      await bootDb();
      const { handleArchiveMemoryStore } = await import("../src/handlers/memory");
      const res = await handleArchiveMemoryStore(
        req(`/v1/memory_stores/memstore_NONEXISTENT/archive`, { method: "POST", body: {} }),
        "memstore_NONEXISTENT",
      );
      expect(res.status).toBe(404);
    });
  });

  // ── memory_store resource on session create ───────────────────────────

  describe("memory_store session resource", () => {
    it("accepts memory_store in resources on session create", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory } = await import("../src/db/memory");
      const { handleCreateSession } = await import("../src/handlers/anthropic-compat/sessions");
      const agent = await createTestAgent();
      const env = await createTestEnv();

      const store = createMemoryStore({ name: "my-notes", agent_id: agent.id as string });
      createOrUpsertMemory(store.id, "readme.md", "# Hello");

      const res = await handleCreateSession(
        req("/anthropic/v1/sessions", {
          body: {
            agent: agent.id,
            environment_id: env.id,
            resources: [
              { type: "memory_store", memory_store_id: store.id, access: "read_write", instructions: "Keep notes here" },
            ],
          },
        }),
      );
      expect(res.status).toBe(201);

      // Verify resource was stored
      const { listResources } = await import("../src/db/session-resources");
      const sessionBody = await res.json();
      const resources = listResources(sessionBody.id);
      const memRes = resources.find(r => r.type === "memory_store");
      expect(memRes).toBeDefined();
      expect(memRes!.memory_store_id).toBe(store.id);
      expect(memRes!.access).toBe("read_write");
      expect(memRes!.instructions).toBe("Keep notes here");
    });

    it("allows attaching ANOTHER agent's store when access:read_only", async () => {
      await bootDb();
      const { createMemoryStore, createOrUpsertMemory } = await import("../src/db/memory");
      const { handleCreateSession } = await import("../src/handlers/anthropic-compat/sessions");
      const agentA = await createTestAgent();
      const agentB = await createTestAgent();
      const env = await createTestEnv();

      // Store owned by agent B; session runs agent A.
      const storeB = createMemoryStore({ name: "b-notes", agent_id: agentB.id as string });
      createOrUpsertMemory(storeB.id, "readme.md", "# B");

      const res = await handleCreateSession(
        req("/anthropic/v1/sessions", {
          body: {
            agent: agentA.id,
            environment_id: env.id,
            resources: [{ type: "memory_store", memory_store_id: storeB.id, access: "read_only" }],
          },
        }),
      );
      expect(res.status).toBe(201);
    });

    it("rejects attaching another agent's store as read_write (foreign write)", async () => {
      await bootDb();
      const { createMemoryStore } = await import("../src/db/memory");
      const { handleCreateSession } = await import("../src/handlers/anthropic-compat/sessions");
      const agentA = await createTestAgent();
      const agentB = await createTestAgent();
      const env = await createTestEnv();
      const storeB = createMemoryStore({ name: "b-notes", agent_id: agentB.id as string });

      const res = await handleCreateSession(
        req("/anthropic/v1/sessions", {
          body: {
            agent: agentA.id,
            environment_id: env.id,
            resources: [{ type: "memory_store", memory_store_id: storeB.id, access: "read_write" }],
          },
        }),
      );
      expect(res.status).toBe(400);
    });

    it("rejects more than 8 memory_store resources", async () => {
      await bootDb();
      const { createMemoryStore } = await import("../src/db/memory");
      const { handleCreateSession } = await import("../src/handlers/anthropic-compat/sessions");
      const agent = await createTestAgent();
      const env = await createTestEnv();

      const stores = [];
      for (let i = 0; i < 9; i++) {
        stores.push(createMemoryStore({ name: `store-${i}`, agent_id: agent.id as string }));
      }

      const res = await handleCreateSession(
        req("/anthropic/v1/sessions", {
          body: {
            agent: agent.id,
            environment_id: env.id,
            resources: stores.map(s => ({
              type: "memory_store",
              memory_store_id: s.id,
            })),
          },
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("max 8");
    });

    it("rejects non-existent memory store", async () => {
      await bootDb();
      const { handleCreateSession } = await import("../src/handlers/anthropic-compat/sessions");
      const agent = await createTestAgent();
      const env = await createTestEnv();

      const res = await handleCreateSession(
        req("/anthropic/v1/sessions", {
          body: {
            agent: agent.id,
            environment_id: env.id,
            resources: [
              { type: "memory_store", memory_store_id: "memstore_NONEXISTENT" },
            ],
          },
        }),
      );
      expect(res.status).toBe(404);
    });

    it("rejects archived memory store", async () => {
      await bootDb();
      const { createMemoryStore, archiveMemoryStore } = await import("../src/db/memory");
      const { handleCreateSession } = await import("../src/handlers/anthropic-compat/sessions");
      const agent = await createTestAgent();
      const env = await createTestEnv();

      const store = createMemoryStore({ name: "archived-store", agent_id: agent.id as string });
      archiveMemoryStore(store.id);

      const res = await handleCreateSession(
        req("/anthropic/v1/sessions", {
          body: {
            agent: agent.id,
            environment_id: env.id,
            resources: [
              { type: "memory_store", memory_store_id: store.id },
            ],
          },
        }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("archived");
    });

    it("defaults access to read_write", async () => {
      await bootDb();
      const { createMemoryStore } = await import("../src/db/memory");
      const { handleCreateSession } = await import("../src/handlers/anthropic-compat/sessions");
      const agent = await createTestAgent();
      const env = await createTestEnv();

      const store = createMemoryStore({ name: "my-store", agent_id: agent.id as string });

      const res = await handleCreateSession(
        req("/anthropic/v1/sessions", {
          body: {
            agent: agent.id,
            environment_id: env.id,
            resources: [
              { type: "memory_store", memory_store_id: store.id },
            ],
          },
        }),
      );
      expect(res.status).toBe(201);

      const { listResources } = await import("../src/db/session-resources");
      const sessionBody = await res.json();
      const resources = listResources(sessionBody.id);
      const memRes = resources.find(r => r.type === "memory_store");
      expect(memRes!.access).toBe("read_write");
    });
  });

  // ── System prompt injection ─────────────────────────────────────────

  describe("system prompt injection", () => {
    it("withGatewayPreamble includes memory store info when provided", async () => {
      const { withGatewayPreamble } = await import("../src/backends/shared/wrap-prompt");

      const result = withGatewayPreamble("You are a helpful assistant.", [
        { name: "project-notes", access: "read_write", description: "Project documentation", instructions: "Keep docs updated" },
        { name: "config", access: "read_only", description: "Configuration files" },
      ]);

      expect(result).toContain("Memory stores are mounted at /mnt/memory/:");
      expect(result).toContain("/mnt/memory/project-notes/ (read_write)");
      expect(result).toContain("Project documentation");
      expect(result).toContain("Keep docs updated");
      expect(result).toContain("/mnt/memory/config/ (read_only)");
    });

    it("withGatewayPreamble works without memory stores", async () => {
      const { withGatewayPreamble } = await import("../src/backends/shared/wrap-prompt");

      const result = withGatewayPreamble("You are a helpful assistant.");
      expect(result).not.toContain("Memory stores");
      expect(result).toContain("AgentStep sandboxed container");
    });
  });

  // ── Migration ─────────────────────────────────────────────────────────

  describe("migration", () => {
    it("memory_versions table exists after migration", async () => {
      await bootDb();
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_versions'",
      ).all();
      expect(tables).toHaveLength(1);
    });

    it("memory_stores has archived_at column", async () => {
      await bootDb();
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const cols = db.prepare("PRAGMA table_info(memory_stores)").all() as Array<{ name: string }>;
      const names = cols.map(c => c.name);
      expect(names).toContain("archived_at");
    });
  });
});

describe("read-only memory-sync filter", () => {
  it("selects only read_write memory_store resources for write-back", async () => {
    const { selectWritableMemoryResources } = await import("../src/sync/memory-sync");
    const resources = [
      { type: "memory_store", memory_store_id: "ms_rw", access: "read_write" },
      { type: "memory_store", memory_store_id: "ms_ro", access: "read_only" },
      { type: "memory_store", memory_store_id: "ms_default" }, // no access → not writable
      { type: "file", file_id: "f_1" },
    ];
    const writable = selectWritableMemoryResources(resources);
    expect(writable.map(r => r.memory_store_id)).toEqual(["ms_rw"]);
  });
});
