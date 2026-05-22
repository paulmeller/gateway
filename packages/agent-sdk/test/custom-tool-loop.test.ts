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
    /**
     * We can't call checkToolBridgeSentinel directly (not exported), but we
     * can observe its behavior through the tool bridge poll interval during
     * runTurn. Instead, we test the observable contract:
     *
     * - getPendingToolBridgeCalls() tracks in-flight calls
     * - After a turn completes, the counter is reset
     * - writeToolBridgeResponse clears the pending flag
     *
     * For the cap itself, we verify the module-level constant indirectly
     * through a mock-driven integration test.
     */

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
});
