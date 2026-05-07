import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-dream-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
}

beforeEach(() => {
  freshDbEnv();
});

describe("dreaming — extractSessionSummary", () => {
  it("extracts user and agent messages into a summary", async () => {
    const { extractSessionSummary } = await import("../src/dreaming/review");

    const events = [
      { type: "user.message", payload_json: JSON.stringify({ content: [{ type: "text", text: "Hello, help me with X" }] }) },
      { type: "agent.message", payload_json: JSON.stringify({ content: [{ type: "text", text: "Sure, I can help with X" }] }) },
      { type: "user.message", payload_json: JSON.stringify({ content: [{ type: "text", text: "Thanks!" }] }) },
    ];

    const summary = extractSessionSummary("sess_123", "Test Session", events);

    expect(summary).toContain("Session sess_123 (Test Session):");
    expect(summary).toContain("[User] Hello, help me with X");
    expect(summary).toContain("[Agent] Sure, I can help with X");
    expect(summary).toContain("[User] Thanks!");
  });

  it("includes errors in the summary", async () => {
    const { extractSessionSummary } = await import("../src/dreaming/review");

    const events = [
      { type: "user.message", payload_json: JSON.stringify({ content: [{ type: "text", text: "Do something" }] }) },
      { type: "session.error", payload_json: JSON.stringify({ message: "Container crashed" }) },
    ];

    const summary = extractSessionSummary("sess_456", null, events);

    expect(summary).toContain("Session sess_456:");
    expect(summary).not.toContain("(");
    expect(summary).toContain("[User] Do something");
    expect(summary).toContain("Errors: Container crashed");
  });

  it("handles string content format", async () => {
    const { extractSessionSummary } = await import("../src/dreaming/review");

    const events = [
      { type: "user.message", payload_json: JSON.stringify({ content: "Simple string message" }) },
    ];

    const summary = extractSessionSummary("sess_789", null, events);
    expect(summary).toContain("[User] Simple string message");
  });

  it("truncates long messages", async () => {
    const { extractSessionSummary } = await import("../src/dreaming/review");

    const longText = "x".repeat(1000);
    const events = [
      { type: "user.message", payload_json: JSON.stringify({ content: [{ type: "text", text: longText }] }) },
    ];

    const summary = extractSessionSummary("sess_long", null, events);
    // Message should be truncated to 500 chars
    expect(summary.length).toBeLessThan(1000);
  });

  it("skips events with invalid JSON", async () => {
    const { extractSessionSummary } = await import("../src/dreaming/review");

    const events = [
      { type: "user.message", payload_json: "not valid json{{{" },
      { type: "user.message", payload_json: JSON.stringify({ content: [{ type: "text", text: "Valid" }] }) },
    ];

    const summary = extractSessionSummary("sess_bad", null, events);
    expect(summary).toContain("[User] Valid");
    expect(summary).not.toContain("not valid json");
  });
});

describe("dreaming — reviewSessions", () => {
  it("returns empty result when no sessions exist", async () => {
    const { getDb } = await import("../src/db/client");
    const { reviewSessions } = await import("../src/dreaming/review");
    const { createMemoryStore } = await import("../src/db/memory");

    // Setup DB
    getDb();

    const store = createMemoryStore({ name: "test-store" });

    // Set a fake API key (won't be called since there are no sessions)
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";

    const result = await reviewSessions({
      storeId: store.id,
      lookbackMs: 24 * 60 * 60 * 1000,
      dryRun: true,
    });

    expect(result.sessionCount).toBe(0);
    expect(result.proposedChanges).toEqual([]);
    expect(result.applied).toBe(false);

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("throws when memory store does not exist", async () => {
    const { getDb } = await import("../src/db/client");
    const { reviewSessions } = await import("../src/dreaming/review");

    getDb();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";

    await expect(
      reviewSessions({
        storeId: "memstore_nonexistent",
        lookbackMs: 24 * 60 * 60 * 1000,
        dryRun: true,
      }),
    ).rejects.toThrow("Memory store not found");

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("throws when no API key is provided", async () => {
    const { getDb } = await import("../src/db/client");
    const { reviewSessions } = await import("../src/dreaming/review");
    const { createMemoryStore } = await import("../src/db/memory");

    getDb();
    delete process.env.ANTHROPIC_API_KEY;

    const store = createMemoryStore({ name: "test-store" });

    await expect(
      reviewSessions({
        storeId: store.id,
        lookbackMs: 24 * 60 * 60 * 1000,
        dryRun: true,
      }),
    ).rejects.toThrow("No Anthropic API key");
  });

  it("dry-run returns changes without applying them", async () => {
    const { getDb } = await import("../src/db/client");
    const { reviewSessions } = await import("../src/dreaming/review");
    const { createMemoryStore, listMemories } = await import("../src/db/memory");

    const db = getDb();

    // Create an agent + environment + session with events
    db.prepare(
      `INSERT INTO agents (id, current_version, name, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)`,
    ).run("agent_dream1", "dreamer", Date.now(), Date.now());
    db.prepare(
      `INSERT INTO agent_versions
         (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
       VALUES (?, 1, ?, ?, ?, ?, ?)`,
    ).run("agent_dream1", "claude-sonnet-4-20250514", null, "[]", "{}", Date.now());
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, created_at)
       VALUES (?, ?, ?, 'ready', ?)`,
    ).run("env_dream1", "test-env", "{}", Date.now());
    db.prepare(
      `INSERT INTO sessions (
         id, agent_id, agent_version, environment_id, status,
         title, metadata_json, created_at, updated_at
       ) VALUES (?, ?, 1, ?, 'idle', ?, '{}', ?, ?)`,
    ).run("sess_dream1", "agent_dream1", "env_dream1", "Test Dream Session", Date.now(), Date.now());

    // Insert events
    db.prepare(
      `INSERT INTO events (id, session_id, seq, type, payload_json, received_at, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("evt_d1", "sess_dream1", 1, "user.message", JSON.stringify({ content: [{ type: "text", text: "Always use TypeScript strict mode" }] }), Date.now(), "user");
    db.prepare(
      `INSERT INTO events (id, session_id, seq, type, payload_json, received_at, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("evt_d2", "sess_dream1", 2, "agent.message", JSON.stringify({ content: [{ type: "text", text: "Understood, I will use strict mode." }] }), Date.now(), "backend");
    db.prepare(`UPDATE sessions SET last_seq = 2 WHERE id = 'sess_dream1'`).run();

    const store = createMemoryStore({ name: "dream-test-store" });

    // Mock the fetch call to Anthropic
    const mockResponse = {
      content: [{
        type: "tool_use",
        name: "update_memories",
        input: {
          changes: [{
            operation: "create",
            path: "/preferences/typescript.md",
            content: "# TypeScript Preferences\n\nAlways use strict mode.",
            reason: "User consistently requests TypeScript strict mode.",
          }],
        },
      }],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }) as unknown as typeof fetch;

    try {
      const result = await reviewSessions({
        storeId: store.id,
        lookbackMs: 24 * 60 * 60 * 1000,
        dryRun: true,
        apiKey: "sk-ant-test-key",
      });

      expect(result.sessionCount).toBe(1);
      expect(result.proposedChanges).toHaveLength(1);
      expect(result.proposedChanges[0].operation).toBe("create");
      expect(result.proposedChanges[0].path).toBe("/preferences/typescript.md");
      expect(result.applied).toBe(false);

      // Verify nothing was written to the store
      const memories = listMemories(store.id);
      expect(memories).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("non-dry-run applies changes to the memory store", async () => {
    const { getDb } = await import("../src/db/client");
    const { reviewSessions } = await import("../src/dreaming/review");
    const { createMemoryStore, listMemories } = await import("../src/db/memory");

    const db = getDb();

    // Create an agent + environment + session with events
    db.prepare(
      `INSERT INTO agents (id, current_version, name, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)`,
    ).run("agent_dream2", "dreamer", Date.now(), Date.now());
    db.prepare(
      `INSERT INTO agent_versions
         (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
       VALUES (?, 1, ?, ?, ?, ?, ?)`,
    ).run("agent_dream2", "claude-sonnet-4-20250514", null, "[]", "{}", Date.now());
    db.prepare(
      `INSERT INTO environments (id, name, config_json, state, created_at)
       VALUES (?, ?, ?, 'ready', ?)`,
    ).run("env_dream2", "test-env", "{}", Date.now());
    db.prepare(
      `INSERT INTO sessions (
         id, agent_id, agent_version, environment_id, status,
         title, metadata_json, created_at, updated_at
       ) VALUES (?, ?, 1, ?, 'idle', ?, '{}', ?, ?)`,
    ).run("sess_dream2", "agent_dream2", "env_dream2", "Apply Session", Date.now(), Date.now());

    db.prepare(
      `INSERT INTO events (id, session_id, seq, type, payload_json, received_at, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("evt_d3", "sess_dream2", 1, "user.message", JSON.stringify({ content: [{ type: "text", text: "Use 2-space indentation" }] }), Date.now(), "user");
    db.prepare(`UPDATE sessions SET last_seq = 1 WHERE id = 'sess_dream2'`).run();

    const store = createMemoryStore({ name: "dream-apply-store" });

    const mockResponse = {
      content: [{
        type: "tool_use",
        name: "update_memories",
        input: {
          changes: [{
            operation: "create",
            path: "/preferences/indentation.md",
            content: "Use 2-space indentation for all code.",
            reason: "User preference for formatting.",
          }],
        },
      }],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }) as unknown as typeof fetch;

    try {
      const result = await reviewSessions({
        storeId: store.id,
        lookbackMs: 24 * 60 * 60 * 1000,
        dryRun: false,
        apiKey: "sk-ant-test-key",
      });

      expect(result.applied).toBe(true);
      expect(result.proposedChanges).toHaveLength(1);

      // Verify the memory was created
      const memories = listMemories(store.id);
      expect(memories).toHaveLength(1);
      expect(memories[0].path).toBe("/preferences/indentation.md");
      expect(memories[0].content).toBe("Use 2-space indentation for all code.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
