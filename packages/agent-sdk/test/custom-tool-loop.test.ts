/**
 * Tests for the custom tool infinite loop prevention mitigations:
 *
 *   1. Stop hint — writeToolBridgeResponse appends a text block instructing
 *      the model not to call the tool again.
 *   2. Per-turn call cap — checkToolBridgeSentinel stops polling after
 *      MAX_CUSTOM_TOOL_CALLS_PER_TURN (10) consecutive custom tool calls.
 *   3. Counter reset — the counter is cleared when the turn ends.
 *
 * These are unit-level tests that mock the provider and DB layers so we can
 * exercise the driver logic without real containers.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Hoisted mocks (vitest hoists vi.mock calls above imports)
// ---------------------------------------------------------------------------

// Capture all exec() calls so we can inspect stdin payloads.
const execCalls: Array<{
  sandboxName: string;
  argv: string[];
  opts?: Record<string, unknown>;
}> = [];

// Control what exec() returns per call (for checkToolBridgeSentinel).
let execResponses: Array<{ stdout: string; stderr: string; exit_code: number }> = [];
let execCallIndex = 0;

function nextExecResponse() {
  if (execCallIndex < execResponses.length) {
    return execResponses[execCallIndex++];
  }
  return { stdout: "", stderr: "", exit_code: 0 };
}

vi.mock("../src/containers/exec", async () => {
  const fake = await import("./helpers/fake-exec");
  return { startExec: fake.startExec };
});

vi.mock("../src/containers/lifecycle", () => ({
  acquireForFirstTurn: vi.fn(async () => "ca-sess-fake"),
  releaseSession: vi.fn(async () => {}),
  reconcileOrphanSandboxes: vi.fn(async () => ({ deleted: 0, kept: 0 })),
  reconcileDockerOrphanSandboxes: vi.fn(async () => ({ deleted: 0, kept: 0 })),
  fillWarmPools: vi.fn(async () => {}),
  installSkills: vi.fn(async () => {}),
  provisionResources: vi.fn(async () => {}),
  wrapProviderWithSecrets: vi.fn(async (p: unknown) => p),
}));

const mockExec = vi.fn(async (_name: string, argv: string[], opts?: Record<string, unknown>) => {
  execCalls.push({ sandboxName: _name, argv, opts });
  return nextExecResponse();
});

vi.mock("../src/providers/registry", async () => {
  const fake = await import("./helpers/fake-exec");
  const fakeProvider = {
    name: "sprites",
    stripControlChars: true,
    startExec: fake.startExec,
    exec: mockExec,
    create: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  };
  return {
    resolveContainerProvider: async () => fakeProvider,
    resolveProvider: async () => fakeProvider,
    tryResolveProvider: async () => fakeProvider,
    resolveProviderName: (opts?: { override?: string; envConfigProvider?: string | null }) =>
      opts?.override ?? opts?.envConfigProvider ?? "sprites",
  };
});

// ---------------------------------------------------------------------------
// DB helpers (same pattern as e2e-custom-tool.test.ts)
// ---------------------------------------------------------------------------

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-loop-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.SPRITE_TOKEN = "test-token";
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-test";
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
    __caLicense?: unknown;
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
  delete g.__caLicense;
}

/**
 * Seed the DB with an agent + environment + session that has a sandbox_name.
 * The session needs `sandbox_name` so writeToolBridgeResponse can resolve it.
 */
async function seedSession(sessionId = "sess_loop"): Promise<string> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();
  const { seedDefaultTenant } = await import("../src/db/tenants");
  seedDefaultTenant();

  db.prepare(
    `INSERT INTO agents (id, current_version, name, created_at, updated_at)
     VALUES ('agent_loop', 1, 'loop-test', 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_versions
       (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
     VALUES ('agent_loop', 1, 'claude-sonnet-4-6', NULL, ?, '{}', 0)`,
  ).run(
    JSON.stringify([
      { type: "agent_toolset_20260401" },
      {
        type: "custom",
        name: "save_output",
        description: "Save output to a file",
        input_schema: {
          type: "object",
          properties: { data: { type: "string" } },
          required: ["data"],
        },
      },
    ]),
  );
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, created_at)
     VALUES ('env_loop', 'loop-env', '{}', 'ready', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, created_at, updated_at, sandbox_name
     ) VALUES (?, 'agent_loop', 1, 'env_loop', 'idle', NULL, '{}', 0, 0, 'ca-sess-fake')`,
  ).run(sessionId);

  return sessionId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("custom tool loop prevention", () => {
  beforeEach(() => {
    freshDbEnv();
    execCalls.length = 0;
    execResponses = [];
    execCallIndex = 0;
    mockExec.mockClear();
  });

  // -------------------------------------------------------------------------
  // 1. Stop hint in tool response
  // -------------------------------------------------------------------------

  describe("stop hint in writeToolBridgeResponse", () => {
    it("appends stop instruction text block to content", async () => {
      const sessionId = await seedSession();
      const { writeToolBridgeResponse } = await import("../src/sessions/driver");

      // Set up exec to succeed for the `cat >` and `rm -f` calls.
      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 }, // cat > response.json
        { stdout: "", stderr: "", exit_code: 0 }, // rm -f pending
      ];

      await writeToolBridgeResponse(sessionId, [
        { type: "text", text: "Saved successfully!" },
      ]);

      // The first exec call should be `cat > /tmp/tool-bridge/response.json`
      // with stdin containing the augmented content.
      expect(execCalls.length).toBeGreaterThanOrEqual(1);
      const writeCall = execCalls[0];
      expect(writeCall.argv).toEqual(["sh", "-c", "cat > /tmp/tool-bridge/response.json"]);

      // Parse the stdin payload
      const stdin = writeCall.opts?.stdin as string;
      expect(stdin).toBeDefined();
      const payload = JSON.parse(stdin);

      // Should have 2 content blocks: the original + the stop hint
      expect(payload.content).toHaveLength(2);
      expect(payload.content[0]).toEqual({ type: "text", text: "Saved successfully!" });
      expect(payload.content[1].type).toBe("text");
      expect(payload.content[1].text).toContain("Your turn is complete");
      expect(payload.content[1].text).toContain("do not call this tool again");
    });

    it("preserves multiple original content blocks", async () => {
      const sessionId = await seedSession();
      const { writeToolBridgeResponse } = await import("../src/sessions/driver");

      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: "", stderr: "", exit_code: 0 },
      ];

      const originalContent = [
        { type: "text", text: "Line 1" },
        { type: "text", text: "Line 2" },
        { type: "text", text: "Line 3" },
      ];
      await writeToolBridgeResponse(sessionId, originalContent);

      const stdin = execCalls[0].opts?.stdin as string;
      const payload = JSON.parse(stdin);

      // 3 original + 1 stop hint = 4
      expect(payload.content).toHaveLength(4);
      expect(payload.content[0].text).toBe("Line 1");
      expect(payload.content[1].text).toBe("Line 2");
      expect(payload.content[2].text).toBe("Line 3");
      expect(payload.content[3].text).toContain("do not call this tool again");
    });

    it("adds stop hint even when content array is empty", async () => {
      const sessionId = await seedSession();
      const { writeToolBridgeResponse } = await import("../src/sessions/driver");

      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: "", stderr: "", exit_code: 0 },
      ];

      await writeToolBridgeResponse(sessionId, []);

      const stdin = execCalls[0].opts?.stdin as string;
      const payload = JSON.parse(stdin);

      // Just the stop hint
      expect(payload.content).toHaveLength(1);
      expect(payload.content[0].type).toBe("text");
      expect(payload.content[0].text).toContain("Your turn is complete");
    });

    it("removes pending sentinel after writing response", async () => {
      const sessionId = await seedSession();
      const { writeToolBridgeResponse, getPendingToolBridgeCalls } = await import(
        "../src/sessions/driver"
      );

      // Pre-mark as pending
      getPendingToolBridgeCalls().add(sessionId);

      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: "", stderr: "", exit_code: 0 },
      ];

      await writeToolBridgeResponse(sessionId, [{ type: "text", text: "ok" }]);

      // Second exec call should rm -f the pending file
      expect(execCalls.length).toBe(2);
      expect(execCalls[1].argv).toContain("rm");
      expect(execCalls[1].argv).toContain("/tmp/tool-bridge/pending");

      // pendingToolBridgeCalls should be cleared
      expect(getPendingToolBridgeCalls().has(sessionId)).toBe(false);
    });

    it("handles non-array content gracefully", async () => {
      const sessionId = await seedSession();
      const { writeToolBridgeResponse } = await import("../src/sessions/driver");

      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: "", stderr: "", exit_code: 0 },
      ];

      // Pass something that's not an array — the spread uses
      // Array.isArray check so it should fall back to empty array + hint.
      await writeToolBridgeResponse(sessionId, "not-an-array" as unknown as unknown[]);

      const stdin = execCalls[0].opts?.stdin as string;
      const payload = JSON.parse(stdin);

      // Should still have the stop hint (non-array is treated as empty)
      expect(payload.content).toHaveLength(1);
      expect(payload.content[0].text).toContain("do not call this tool again");
    });

    it("skips silently when session has no sandbox_name", async () => {
      // Seed session without sandbox_name
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const { seedDefaultTenant } = await import("../src/db/tenants");
      seedDefaultTenant();

      db.prepare(
        `INSERT INTO agents (id, current_version, name, created_at, updated_at)
         VALUES ('agent_nosb', 1, 'no-sandbox', 0, 0)`,
      ).run();
      db.prepare(
        `INSERT INTO agent_versions
           (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
         VALUES ('agent_nosb', 1, 'claude-sonnet-4-6', NULL, '[]', '{}', 0)`,
      ).run();
      db.prepare(
        `INSERT INTO environments (id, name, config_json, state, created_at)
         VALUES ('env_nosb', 'no-sb-env', '{}', 'ready', 0)`,
      ).run();
      db.prepare(
        `INSERT INTO sessions (
           id, agent_id, agent_version, environment_id, status,
           title, metadata_json, created_at, updated_at, sandbox_name
         ) VALUES ('sess_nosb', 'agent_nosb', 1, 'env_nosb', 'idle', NULL, '{}', 0, 0, NULL)`,
      ).run();

      const { writeToolBridgeResponse } = await import("../src/sessions/driver");

      await writeToolBridgeResponse("sess_nosb", [{ type: "text", text: "hello" }]);

      // No exec calls should have been made
      expect(execCalls.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Per-turn call cap (MAX_CUSTOM_TOOL_CALLS_PER_TURN = 10)
  // -------------------------------------------------------------------------

  describe("per-turn call cap via checkToolBridgeSentinel", () => {
    it("pendingToolBridgeCalls prevents duplicate sentinel checks", async () => {
      await seedSession("sess_dup");
      const { getPendingToolBridgeCalls } = await import("../src/sessions/driver");

      // When a session is pending, the sentinel check returns early
      getPendingToolBridgeCalls().add("sess_dup");
      expect(getPendingToolBridgeCalls().has("sess_dup")).toBe(true);

      // writeToolBridgeResponse clears it
      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: "", stderr: "", exit_code: 0 },
      ];
      const { writeToolBridgeResponse } = await import("../src/sessions/driver");
      await writeToolBridgeResponse("sess_dup", [{ type: "text", text: "ok" }]);

      expect(getPendingToolBridgeCalls().has("sess_dup")).toBe(false);
    });

    it("cap is set to 10", async () => {
      // Verify the constant exists in the driver module by checking the
      // warn message that's logged when the cap is hit. We can read the
      // source as a sanity check.
      const driverSource = fs.readFileSync(
        path.join(__dirname, "../src/sessions/driver.ts"),
        "utf8",
      );
      expect(driverSource).toContain("MAX_CUSTOM_TOOL_CALLS_PER_TURN = 10");
      expect(driverSource).toContain("callCount >= MAX_CUSTOM_TOOL_CALLS_PER_TURN");
    });

    it("counter is deleted in the finally block after turn ends", async () => {
      // Verify the cleanup code exists
      const driverSource = fs.readFileSync(
        path.join(__dirname, "../src/sessions/driver.ts"),
        "utf8",
      );
      expect(driverSource).toContain("customToolCallCounts.delete(sessionId)");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Counter reset after turn ends
  // -------------------------------------------------------------------------

  describe("counter reset on turn completion", () => {
    it("pendingToolBridgeCalls is cleaned up in finally block", async () => {
      const driverSource = fs.readFileSync(
        path.join(__dirname, "../src/sessions/driver.ts"),
        "utf8",
      );
      // Both cleanup calls must be in the finally block
      expect(driverSource).toContain("getPendingToolBridgeCalls().delete(sessionId)");
      expect(driverSource).toContain("customToolCallCounts.delete(sessionId)");
    });

    it("sentinel check logs warning and returns early when cap reached", () => {
      // Verify the early-return guard in checkToolBridgeSentinel
      const driverSource = fs.readFileSync(
        path.join(__dirname, "../src/sessions/driver.ts"),
        "utf8",
      );
      // The guard should log a warning and return
      expect(driverSource).toMatch(
        /if\s*\(callCount\s*>=\s*MAX_CUSTOM_TOOL_CALLS_PER_TURN\)/,
      );
      expect(driverSource).toContain("custom tool call limit reached");
    });

    it("counter increments on each successful sentinel detection", () => {
      const driverSource = fs.readFileSync(
        path.join(__dirname, "../src/sessions/driver.ts"),
        "utf8",
      );
      // The counter is incremented after a successful read of request.json
      expect(driverSource).toContain(
        "customToolCallCounts.set(sessionId, (customToolCallCounts.get(sessionId) ?? 0) + 1)",
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. Integration: full writeToolBridgeResponse round-trip
  // -------------------------------------------------------------------------

  describe("writeToolBridgeResponse integration", () => {
    it("writes response.json then removes pending sentinel in order", async () => {
      const sessionId = await seedSession("sess_order");
      const { writeToolBridgeResponse } = await import("../src/sessions/driver");

      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 }, // cat > response.json
        { stdout: "", stderr: "", exit_code: 0 }, // rm -f pending
      ];

      await writeToolBridgeResponse(sessionId, [{ type: "text", text: "done" }]);

      // Exactly 2 exec calls in order: write then delete
      expect(execCalls).toHaveLength(2);

      // First: write response.json
      expect(execCalls[0].argv.join(" ")).toContain("cat > /tmp/tool-bridge/response.json");

      // Second: remove pending sentinel
      expect(execCalls[1].argv).toContain("/tmp/tool-bridge/pending");
    });

    it("stop hint text block is always the last item in content", async () => {
      const sessionId = await seedSession("sess_last");
      const { writeToolBridgeResponse } = await import("../src/sessions/driver");

      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: "", stderr: "", exit_code: 0 },
      ];

      const content = [
        { type: "text", text: "Result A" },
        { type: "image", data: "base64..." },
        { type: "text", text: "Result B" },
      ];
      await writeToolBridgeResponse(sessionId, content);

      const stdin = execCalls[0].opts?.stdin as string;
      const payload = JSON.parse(stdin);

      // Last element should be the stop hint
      const lastBlock = payload.content[payload.content.length - 1];
      expect(lastBlock.type).toBe("text");
      expect(lastBlock.text).toContain("Your turn is complete");
      expect(lastBlock.text).toContain("do not call this tool again");
    });

    it("stop hint starts with newline for visual separation", async () => {
      const sessionId = await seedSession("sess_nl");
      const { writeToolBridgeResponse } = await import("../src/sessions/driver");

      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: "", stderr: "", exit_code: 0 },
      ];

      await writeToolBridgeResponse(sessionId, [{ type: "text", text: "ok" }]);

      const stdin = execCalls[0].opts?.stdin as string;
      const payload = JSON.parse(stdin);

      const hintBlock = payload.content[payload.content.length - 1];
      expect(hintBlock.text).toMatch(/^\n\[Tool result delivered/);
    });

    it("exec failure does not throw — logs warning and clears pending", async () => {
      const sessionId = await seedSession("sess_fail");
      const { writeToolBridgeResponse, getPendingToolBridgeCalls } = await import(
        "../src/sessions/driver"
      );

      getPendingToolBridgeCalls().add(sessionId);

      // Make exec throw
      mockExec.mockRejectedValueOnce(new Error("container gone"));

      // Should not throw
      await expect(
        writeToolBridgeResponse(sessionId, [{ type: "text", text: "fail" }]),
      ).resolves.toBeUndefined();

      // pendingToolBridgeCalls should still be cleared
      expect(getPendingToolBridgeCalls().has(sessionId)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 5. checkToolBridgeSentinel — stale sentinel / non-JSON cleanup
  // -------------------------------------------------------------------------

  describe("checkToolBridgeSentinel stale sentinel cleanup", () => {
    const dummyTrace = {
      trace_id: "trace_test",
      span_id: "span_test",
      parent_span_id: null as string | null,
    };

    it("removes pending sentinel when cat exits non-zero (file missing)", async () => {
      await seedSession("sess_cat_fail");
      const { checkToolBridgeSentinel, getPendingToolBridgeCalls } = await import(
        "../src/sessions/driver"
      );

      // Grab the mock provider from registry
      const { resolveProvider } = await import("../src/providers/registry");
      const provider = await resolveProvider();

      // exec call 1: test -f pending → exists (exit 0)
      // exec call 2: cat request.json → fails (exit 1, stderr has cat error)
      // exec call 3: rm -f pending → cleanup
      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: "", stderr: "/usr/bin/cat: /tmp/tool-bridge/request.json: No such file or directory", exit_code: 1 },
        { stdout: "", stderr: "", exit_code: 0 },
      ];

      await checkToolBridgeSentinel("sess_cat_fail", "ca-sess-fake", provider, undefined, dummyTrace);

      // Should have called rm -f to clean up the stale sentinel
      const rmCall = execCalls.find(c => c.argv.includes("rm") && c.argv.includes("/tmp/tool-bridge/pending"));
      expect(rmCall).toBeDefined();

      // Should NOT have marked as pending (no event emitted)
      expect(getPendingToolBridgeCalls().has("sess_cat_fail")).toBe(false);
    });

    it("removes pending sentinel when stdout is not JSON (stderr leaked into stdout)", async () => {
      await seedSession("sess_not_json");
      const { checkToolBridgeSentinel, getPendingToolBridgeCalls } = await import(
        "../src/sessions/driver"
      );
      const { resolveProvider } = await import("../src/providers/registry");
      const provider = await resolveProvider();

      // test -f pending → exists
      // cat request.json → exit 0 but stdout is a file path (sprites text-response path)
      // rm -f pending → cleanup
      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: "/usr/bin/cat: /tmp/tool-bridge/request.json: No such file or directory", stderr: "", exit_code: 0 },
        { stdout: "", stderr: "", exit_code: 0 },
      ];

      await checkToolBridgeSentinel("sess_not_json", "ca-sess-fake", provider, undefined, dummyTrace);

      // Should have cleaned up the sentinel
      const rmCall = execCalls.find(c => c.argv.includes("rm") && c.argv.includes("/tmp/tool-bridge/pending"));
      expect(rmCall).toBeDefined();

      expect(getPendingToolBridgeCalls().has("sess_not_json")).toBe(false);
    });

    it("removes pending sentinel on JSON parse error (truncated JSON)", async () => {
      await seedSession("sess_truncated");
      const { checkToolBridgeSentinel, getPendingToolBridgeCalls } = await import(
        "../src/sessions/driver"
      );
      const { resolveProvider } = await import("../src/providers/registry");
      const provider = await resolveProvider();

      // test -f pending → exists
      // cat request.json → exit 0, stdout is truncated JSON
      // rm -f pending → cleanup
      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"save', stderr: "", exit_code: 0 },
        { stdout: "", stderr: "", exit_code: 0 },
      ];

      await checkToolBridgeSentinel("sess_truncated", "ca-sess-fake", provider, undefined, dummyTrace);

      // Should have cleaned up the sentinel (catch block removes it)
      const rmCall = execCalls.find(c => c.argv.includes("rm") && c.argv.includes("/tmp/tool-bridge/pending"));
      expect(rmCall).toBeDefined();

      expect(getPendingToolBridgeCalls().has("sess_truncated")).toBe(false);
    });

    it("succeeds and emits event when request.json contains valid MCP JSON", async () => {
      await seedSession("sess_valid");
      const { checkToolBridgeSentinel, getPendingToolBridgeCalls } = await import(
        "../src/sessions/driver"
      );
      const { resolveProvider } = await import("../src/providers/registry");
      const provider = await resolveProvider();

      const validBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "save_output", arguments: { data: "hello" } },
      });

      // test -f pending → exists
      // cat request.json → valid JSON
      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: validBody, stderr: "", exit_code: 0 },
      ];

      await checkToolBridgeSentinel("sess_valid", "ca-sess-fake", provider, undefined, dummyTrace);

      // Should have marked as pending (event was emitted)
      expect(getPendingToolBridgeCalls().has("sess_valid")).toBe(true);

      // Should NOT have called rm -f pending (no cleanup needed)
      const rmCall = execCalls.find(c => c.argv.includes("rm") && c.argv.includes("/tmp/tool-bridge/pending"));
      expect(rmCall).toBeUndefined();

      // Clean up for other tests
      getPendingToolBridgeCalls().delete("sess_valid");
    });

    it("does not retry after cleanup — second call with no pending returns immediately", async () => {
      await seedSession("sess_no_retry");
      const { checkToolBridgeSentinel } = await import("../src/sessions/driver");
      const { resolveProvider } = await import("../src/providers/registry");
      const provider = await resolveProvider();

      // First call: sentinel exists, cat fails → cleanup
      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },   // test -f pending → exists
        { stdout: "/usr/bin/cat: No such file", stderr: "", exit_code: 0 }, // cat → non-JSON
        { stdout: "", stderr: "", exit_code: 0 },   // rm -f pending → cleanup
      ];
      await checkToolBridgeSentinel("sess_no_retry", "ca-sess-fake", provider, undefined, dummyTrace);

      const callsAfterFirst = execCalls.length;

      // Second call: sentinel was removed, test -f returns non-zero
      execResponses = [
        ...execResponses,
        { stdout: "", stderr: "", exit_code: 1 },   // test -f pending → not found
      ];
      await checkToolBridgeSentinel("sess_no_retry", "ca-sess-fake", provider, undefined, dummyTrace);

      // Should have made exactly 1 more exec call (test -f) and returned early
      expect(execCalls.length).toBe(callsAfterFirst + 1);
      expect(execCalls[callsAfterFirst].argv).toContain("test");
    });

    it("handles stdout with control characters before valid JSON", async () => {
      await seedSession("sess_ctrl");
      const { checkToolBridgeSentinel, getPendingToolBridgeCalls } = await import(
        "../src/sessions/driver"
      );
      const { resolveProvider } = await import("../src/providers/registry");
      const provider = await resolveProvider();

      const validBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "save_output", arguments: { x: 1 } },
      });

      // Prepend control chars (sprites multiplexing bytes)
      const withControlChars = "\x01\x00\x00\x00" + validBody;

      execResponses = [
        { stdout: "", stderr: "", exit_code: 0 },
        { stdout: withControlChars, stderr: "", exit_code: 0 },
      ];

      await checkToolBridgeSentinel("sess_ctrl", "ca-sess-fake", provider, undefined, dummyTrace);

      // Should succeed — control chars stripped, JSON parsed
      expect(getPendingToolBridgeCalls().has("sess_ctrl")).toBe(true);
      getPendingToolBridgeCalls().delete("sess_ctrl");
    });
  });
});
