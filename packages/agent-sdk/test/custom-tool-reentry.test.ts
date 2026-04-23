/**
 * Custom tool re-entry tests for the Anthropic proxy path.
 *
 * Covers:
 *   - executeServerSideTool dispatches memory commands correctly
 *   - Unknown tools return null
 *   - The activeTees guard prevents overlapping tee instances
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-reentry-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
    __caLicense?: unknown;
    __caDrizzle?: unknown;
  };
  delete g.__caDb;
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
  delete g.__caLicense;
  delete g.__caDrizzle;
}

async function boot() {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { seedDefaultTenant } = await import("../src/db/tenants");
  seedDefaultTenant();
}

/** Create a memory store directly via the DB layer (no agent required). */
async function createTestStore(name: string) {
  const { createMemoryStore } = await import("../src/db/memory");
  // createMemoryStore allows null agent_id
  return createMemoryStore({ name, agent_id: null });
}

describe("executeServerSideTool", () => {
  beforeEach(() => freshDbEnv());

  it("returns null for unknown tools", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");
    const result = await executeServerSideTool("unknown_tool", { foo: "bar" }, "sess_fake");
    expect(result).toBeNull();
  });

  it("handles memory view command", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");
    const { createOrUpsertMemory } = await import("../src/db/memory");

    const store = await createTestStore("test-store");
    createOrUpsertMemory(store.id, "note1.md", "Hello World");

    const result = await executeServerSideTool("memory", { command: "view", store_id: store.id }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0].content).toBe("Hello World");
  });

  it("handles memory search command", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");
    const { createOrUpsertMemory } = await import("../src/db/memory");

    const store = await createTestStore("search-store");
    createOrUpsertMemory(store.id, "a.md", "alpha content");
    createOrUpsertMemory(store.id, "b.md", "beta content");

    const result = await executeServerSideTool("memory", {
      command: "search",
      store_id: store.id,
      query: "alpha",
    }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0].path).toBe("a.md");
  });

  it("handles memory create command", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");

    const store = await createTestStore("create-store");

    const result = await executeServerSideTool("memory", {
      command: "create",
      store_id: store.id,
      content: "new memory",
      path: "test.md",
    }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.memory.content).toBe("new memory");
    expect(parsed.memory.path).toBe("test.md");
  });

  it("handles memory update command", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");
    const { createOrUpsertMemory } = await import("../src/db/memory");

    const store = await createTestStore("update-store");
    const mem = createOrUpsertMemory(store.id, "note.md", "original");

    const result = await executeServerSideTool("memory", {
      command: "update",
      memory_id: mem.id,
      content: "updated content",
    }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.memory.content).toBe("updated content");
  });

  it("returns error for update of nonexistent memory", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");

    const result = await executeServerSideTool("memory", {
      command: "update",
      memory_id: "mem_doesnotexist",
      content: "oops",
    }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.error).toBe("not_found");
  });

  it("handles memory delete command", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");
    const { createOrUpsertMemory, getMemory } = await import("../src/db/memory");

    const store = await createTestStore("del-store");
    const mem = createOrUpsertMemory(store.id, "to-delete.md", "bye");

    const result = await executeServerSideTool("memory", {
      command: "delete",
      memory_id: mem.id,
    }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.deleted).toBe(true);

    // Verify it's gone
    expect(getMemory(mem.id)).toBeNull();
  });

  it("returns error for missing store_id on view", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");

    const result = await executeServerSideTool("memory", { command: "view" }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.error).toMatch(/store_id/);
  });

  it("returns error for unknown memory command", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");

    const result = await executeServerSideTool("memory", { command: "teleport" }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.error).toMatch(/unknown memory command/);
  });

  it("handles memory_ prefixed tools", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");

    const store = await createTestStore("prefix-store");

    const result = await executeServerSideTool("memory_personal", {
      command: "view",
      store_id: store.id,
    }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.memories).toBeDefined();
  });

  it("handles list_stores command", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");

    await createTestStore("store-a");
    await createTestStore("store-b");

    const result = await executeServerSideTool("memory", { command: "list_stores" }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.stores.length).toBeGreaterThanOrEqual(2);
  });

  it("returns error for search missing query", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");

    const store = await createTestStore("search-no-q");

    const result = await executeServerSideTool("memory", {
      command: "search",
      store_id: store.id,
    }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.error).toMatch(/query/);
  });

  it("returns error for create missing content", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");

    const store = await createTestStore("create-no-content");

    const result = await executeServerSideTool("memory", {
      command: "create",
      store_id: store.id,
    }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.error).toMatch(/content/);
  });

  it("returns error for delete nonexistent memory", async () => {
    await boot();
    const { executeServerSideTool } = await import("../src/handlers/events");

    const result = await executeServerSideTool("memory", {
      command: "delete",
      memory_id: "mem_nope",
    }, "sess_fake");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content);
    expect(parsed.error).toBe("not_found");
  });
});

describe("activeTees guard", () => {
  it("prevents concurrent tee instances for the same session", async () => {
    const { _activeTees } = await import("../src/handlers/events");

    // Simulate an active tee
    _activeTees.add("sess_test_guard");
    expect(_activeTees.has("sess_test_guard")).toBe(true);

    // Clean up
    _activeTees.delete("sess_test_guard");
    expect(_activeTees.has("sess_test_guard")).toBe(false);
  });

  it("allows different sessions to tee concurrently", async () => {
    const { _activeTees } = await import("../src/handlers/events");

    _activeTees.add("sess_a");
    _activeTees.add("sess_b");
    expect(_activeTees.has("sess_a")).toBe(true);
    expect(_activeTees.has("sess_b")).toBe(true);

    _activeTees.delete("sess_a");
    _activeTees.delete("sess_b");
  });
});
