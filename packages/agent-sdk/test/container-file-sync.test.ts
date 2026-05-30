/**
 * Container file sync tests.
 *
 * Validates:
 *   - Path extraction from Write, Edit, file_edit, Bash, apply_patch events
 *   - Path safety (traversal, blocked prefixes)
 *   - Binary extension filtering
 *   - File discovery via mock provider
 *   - Full sync with dedup, size caps, file caps
 *   - Auto-execution of document generation scripts
 *   - Discovery always runs regardless of tool events (regression)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type { ContainerProvider } from "../src/providers/types";

/**
 * Reset all DB/config singletons so each test starts fresh.
 */
function freshDbEnv(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-cfs-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
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
  return dir;
}

/**
 * Insert the minimum rows needed for a session (agent → agent_version → environment → session).
 */
function seedSession(
  db: ReturnType<typeof import("../src/db/client").getDb>,
  sessionId: string,
  agentId = "agent_cfs",
  envId = "env_cfs",
): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO agents (id, current_version, name, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?)`,
  ).run(agentId, "cfs-agent", now, now);
  db.prepare(
    `INSERT OR IGNORE INTO agent_versions
       (agent_id, version, model, system, tools_json, mcp_servers_json, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
  ).run(agentId, "claude-sonnet-4-6", null, "[]", "{}", now);
  db.prepare(
    `INSERT OR IGNORE INTO environments (id, name, config_json, state, created_at)
     VALUES (?, ?, '{}', 'ready', ?)`,
  ).run(envId, "cfs-env", now);
  db.prepare(
    `INSERT OR IGNORE INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, created_at, updated_at
     ) VALUES (?, ?, 1, ?, 'idle', null, '{}', ?, ?)`,
  ).run(sessionId, agentId, envId, now, now);
}

/**
 * Create a fake ContainerProvider that returns controlled exec results.
 *
 * `execResults` maps a substring pattern to the response. When exec is called
 * the first matching pattern wins.
 */
function fakeProvider(
  execResults: Record<string, { stdout: string; stderr: string; exit_code: number }> = {},
): ContainerProvider {
  return {
    name: "docker" as ContainerProvider["name"],
    stripControlChars: false,
    exec: vi.fn(async (_name: string, argv: string[]) => {
      const cmd = argv.join(" ");
      for (const [pattern, result] of Object.entries(execResults)) {
        if (cmd.includes(pattern)) return result;
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    }),
    startExec: vi.fn(async () => ({
      stdout: new ReadableStream(),
      stderr: new ReadableStream(),
      exitCode: Promise.resolve(0),
      kill: vi.fn(),
    })),
    create: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  } as unknown as ContainerProvider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("container-file-sync", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  // =========================================================================
  // Path extraction from events
  // =========================================================================

  describe("path extraction from events", () => {
    it("extracts file paths from Write tool events", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_write";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/test.txt" } },
        origin: "server",
      });

      const provider = fakeProvider({
        // find discovery returns nothing extra
        find: { stdout: "", stderr: "", exit_code: 0 },
        // cat for the extracted file
        "cat": { stdout: "hello world", stderr: "", exit_code: 0 },
        // /mnt/session/outputs returns nothing
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBeGreaterThanOrEqual(1);
      expect(result.files.some(f => f.container_path === "/home/user/test.txt")).toBe(true);
    });

    it("extracts file paths from Edit tool events", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_edit";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Edit", input: { file_path: "/src/main.ts" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "const x = 1;", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.files.some(f => f.container_path === "/src/main.ts")).toBe(true);
    });

    it("extracts file paths from Codex file_edit events", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_codex";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "file_edit", input: { path: "/code/index.js" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "module.exports = {};", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.files.some(f => f.container_path === "/code/index.js")).toBe(true);
    });

    it("extracts file paths from apply_patch events (OpenCode)", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_apatch";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: {
          name: "apply_patch",
          input: { patchText: "*** Add File: /workspace/new.ts\n+ content" },
        },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "export {};", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.files.some(f => f.container_path === "/workspace/new.ts")).toBe(true);
    });

    it("detects Bash tool usage (sawBash = true, suppresses auto-execute)", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_bash";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      // Write a .js file that uses docx
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/gen.js" } },
        origin: "server",
      });
      // Bash was used — so auto-execute should NOT fire
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Bash", input: { command: "node gen.js" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: 'const docx = require("docx");', stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
        "head": { stdout: 'const docx = require("docx");', stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      // Auto-execute should NOT have run because Bash was detected
      expect(result.autoExecuted).toEqual([]);
    });

    it("deduplicates paths from multiple events", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_dedup_evt";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      // Same file path in two different events
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/output.txt" } },
        origin: "server",
      });
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Edit", input: { file_path: "/home/user/output.txt" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "content", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      // Only one file synced even though two events referenced the same path
      const matchingFiles = result.files.filter(f => f.container_path === "/home/user/output.txt");
      expect(matchingFiles.length).toBe(1);
    });

    it("handles events with no file path gracefully", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_nopath";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      // tool_use event with no file_path/path in input
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { content: "hello" } },
        origin: "server",
      });
      // Non-tool event
      appendEvent(sid, {
        type: "agent.message",
        payload: { content: [{ type: "text", text: "done" }] },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      // No files should be synced since no valid paths exist
      expect(result.synced).toBe(0);
    });

    it("resolves relative paths with leading slash", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_relpath";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      // Relative path without leading slash
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "src/output.txt" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "content", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      // Should have been resolved to /src/output.txt
      expect(result.files.some(f => f.container_path === "/src/output.txt")).toBe(true);
    });
  });

  // =========================================================================
  // Path safety
  // =========================================================================

  describe("path safety (tested indirectly through sync)", () => {
    it("rejects paths with .. (path traversal)", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_traversal";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/../../../etc/passwd" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(0);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
    });

    it("rejects paths without leading /", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_noslash";
      seedSession(db, sid);

      // Feed a path directly through discovery (simulating provider find output without /)
      const provider = fakeProvider({
        // find returns a path without leading /
        find: { stdout: "relative/path.txt\n", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      // The path without leading / should be skipped as unsafe
      expect(result.files.some(f => f.container_path === "relative/path.txt")).toBe(false);
    });

    it("rejects blocked system paths (/proc/, /sys/, /dev/, /etc/)", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_blocked";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      const blockedPaths = [
        "/proc/1/cmdline",
        "/sys/class/net/eth0",
        "/dev/null",
        "/etc/passwd",
        "/bin/sh",
        "/sbin/init",
        "/usr/bin/env",
        "/usr/sbin/sshd",
        "/usr/lib/libfoo.so",
        "/var/run/docker.sock",
        "/var/log/syslog",
      ];

      for (const p of blockedPaths) {
        appendEvent(sid, {
          type: "agent.tool_use",
          payload: { name: "Write", input: { file_path: p } },
          origin: "server",
        });
      }

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(0);
      expect(result.skipped).toBe(blockedPaths.length);
    });

    it("rejects wrapper temp files (mktemp default + .claude-cw.* + policy-limits.json) — security regression", async () => {
      // The Claude wrapper script writes credentials (ANTHROPIC_API_KEY,
      // CLAUDE_CODE_OAUTH_TOKEN) into a temp file before su'ing to the
      // agent user. If the discovery scan slurps these files into the
      // gateway's file store, the OAuth token leaks. The fix: filter
      // mktemp's default pattern (`tmp.XXXXXXXXXX`), the wrapper's
      // current convention (`.claude-*`), and Claude CLI internal state
      // (`policy-limits.json`) in isPathSafe via BLOCKED_BASENAME_RE.
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_wrapper_leak";
      seedSession(db, sid);

      // Simulate the find command discovering wrapper temp files in /tmp.
      // No tool events — we're testing the discovery path specifically.
      const provider = fakeProvider({
        find: {
          stdout: "/tmp/tmp.AbCdEfGhIj\n/tmp/tmp.XYZ1234567\n/tmp/.claude-cw.AbCdEfGhIj\n/tmp/.claude-wrapper\n/home/agent/.config/claude/policy-limits.json\n",
          stderr: "",
          exit_code: 0,
        },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      // ALL of these must be rejected. If any one slips through, an
      // OAuth token may have just been written to the gateway's file store.
      expect(result.synced).toBe(0);
    });

    it("accepts safe paths like /home/user/output.docx and /tmp/result.json", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_safe";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/output.txt" } },
        origin: "server",
      });
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/tmp/result.json" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: '{"ok": true}', stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(2);
    });
  });

  // =========================================================================
  // Binary extension filtering
  // =========================================================================

  describe("binary extension filtering", () => {
    it("skips build artifacts (.o, .pyc, .so, .wasm)", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_binext";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      const binaryPaths = [
        "/home/user/main.o",
        "/home/user/module.pyc",
        "/home/user/lib.so",
        "/home/user/app.wasm",
      ];

      for (const p of binaryPaths) {
        appendEvent(sid, {
          type: "agent.tool_use",
          payload: { name: "Write", input: { file_path: p } },
          origin: "server",
        });
      }

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(0);
      expect(result.skipped).toBe(4);
    });

    it("allows document files (.docx, .pdf, .xlsx) — NOT in binary skip list", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_docext";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/report.docx" } },
        origin: "server",
      });
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/data.xlsx" } },
        origin: "server",
      });
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/doc.pdf" } },
        origin: "server",
      });

      // These are binary-read (base64) but NOT in the BINARY_EXTENSIONS skip list
      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        // base64 content for binary files
        "base64": { stdout: Buffer.from("fake binary content").toString("base64"), stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(3);
      expect(result.files.some(f => f.filename === "report.docx")).toBe(true);
      expect(result.files.some(f => f.filename === "data.xlsx")).toBe(true);
      expect(result.files.some(f => f.filename === "doc.pdf")).toBe(true);
    });

    it("allows text files (.txt, .json, .md)", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_textext";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/notes.txt" } },
        origin: "server",
      });
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/config.json" } },
        origin: "server",
      });
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/readme.md" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "text content", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(3);
    });
  });

  // =========================================================================
  // File discovery (with mock provider)
  // =========================================================================

  describe("file discovery", () => {
    it("discovers files in /home via find", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_disc_home";
      seedSession(db, sid);

      const provider = fakeProvider({
        // find discovers a file in /home
        find: { stdout: "/home/user/discovered.txt\n", stderr: "", exit_code: 0 },
        // cat returns content
        "cat": { stdout: "discovered content", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.files.some(f => f.container_path === "/home/user/discovered.txt")).toBe(true);
    });

    it("discovers files in /mnt/session/outputs/ (always scanned)", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_disc_mnt";
      seedSession(db, sid);

      // Use a custom provider because the /mnt/session/outputs scan command
      // also contains "find", so we need to match on the specific path first.
      const provider: ContainerProvider = {
        name: "docker" as ContainerProvider["name"],
        stripControlChars: false,
        exec: vi.fn(async (_name: string, argv: string[]) => {
          const cmd = argv.join(" ");
          if (cmd.includes("/mnt/session/outputs")) {
            return { stdout: "/mnt/session/outputs/report.csv\n", stderr: "", exit_code: 0 };
          }
          if (cmd.includes("cat")) {
            return { stdout: "a,b,c\n1,2,3", stderr: "", exit_code: 0 };
          }
          // Generic find (discovery) returns nothing
          if (cmd.includes("find")) {
            return { stdout: "", stderr: "", exit_code: 0 };
          }
          return { stdout: "", stderr: "", exit_code: 0 };
        }),
        startExec: vi.fn(async () => ({
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exitCode: Promise.resolve(0),
          kill: vi.fn(),
        })),
        create: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
        list: vi.fn(async () => []),
      } as unknown as ContainerProvider;
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.files.some(f => f.container_path === "/mnt/session/outputs/report.csv")).toBe(true);
    });

    it("discovers files in /tmp via find", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_disc_tmp";
      seedSession(db, sid);

      const provider = fakeProvider({
        find: { stdout: "/tmp/scratch.txt\n", stderr: "", exit_code: 0 },
        "cat": { stdout: "temp data", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.files.some(f => f.container_path === "/tmp/scratch.txt")).toBe(true);
    });

    it("handles empty find results", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_disc_empty";
      seedSession(db, sid);

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(0);
      expect(result.files).toEqual([]);
    });

    it("strips sprites control characters from find output", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_disc_ctrl";
      seedSession(db, sid);

      // Simulate sprites HTTP exec framing bytes mixed into stdout
      const provider = fakeProvider({
        find: {
          stdout: "\x01\x02/home/user/clean.txt\x03\n",
          stderr: "", exit_code: 0,
        },
        "cat": { stdout: "clean content", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.files.some(f => f.container_path === "/home/user/clean.txt")).toBe(true);
    });

    it("discovery always runs regardless of tool events — KEY REGRESSION TEST", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_disc_always";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      // Only add a custom tool event — NOT Write, Edit, Bash, or file_edit.
      // In the buggy version, discovery would only run when sawFileTools or sawBash was true.
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "custom_generate_report", input: { topic: "sales" } },
        origin: "server",
      });

      const provider = fakeProvider({
        // find discovers a file written by the custom tool via MCP
        find: { stdout: "/home/user/sales-report.txt\n", stderr: "", exit_code: 0 },
        "cat": { stdout: "Sales data here", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      // Discovery MUST still run and find the file even without Write/Edit/Bash events
      expect(result.synced).toBeGreaterThanOrEqual(1);
      expect(result.files.some(f => f.container_path === "/home/user/sales-report.txt")).toBe(true);
    });
  });

  // =========================================================================
  // Full sync (with mock provider)
  // =========================================================================

  describe("full sync", () => {
    it("syncs text files from container", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_synctext";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/hello.ts" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: 'export const greeting = "hello";', stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(1);
      expect(result.files[0].filename).toBe("hello.ts");
      expect(result.files[0].mime_type).toBe("text/typescript");
      expect(result.files[0].size_bytes).toBeGreaterThan(0);
    });

    it("syncs binary files (docx) via base64", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_syncbin";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/report.docx" } },
        origin: "server",
      });

      const fakeDocxContent = Buffer.from("PK\x03\x04 fake docx zip");
      const b64 = fakeDocxContent.toString("base64");

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "base64": { stdout: b64, stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(1);
      expect(result.files[0].filename).toBe("report.docx");
      expect(result.files[0].mime_type).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      expect(result.files[0].size_bytes).toBe(fakeDocxContent.length);
    });

    it("deduplicates files by container path + hash", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_syncdedup";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/data.txt" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "same content", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");

      // First sync
      const r1 = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });
      expect(r1.synced).toBe(1);

      // Second sync with same content — should be deduplicated
      const r2 = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });
      expect(r2.synced).toBe(0);
      expect(r2.skipped).toBeGreaterThanOrEqual(1);
    });

    it("skips files larger than 50MB", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_toobig";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/huge.txt" } },
        origin: "server",
      });

      // Create content larger than 50MB
      const bigContent = "x".repeat(51 * 1024 * 1024);

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: bigContent, stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(0);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
    });

    it("caps at 20 files per sync", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_cap";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      // Create 25 file events
      for (let i = 0; i < 25; i++) {
        appendEvent(sid, {
          type: "agent.tool_use",
          payload: { name: "Write", input: { file_path: `/home/user/file${i}.txt` } },
          origin: "server",
        });
      }

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "file content", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      // Should sync exactly 20 (MAX_FILES_PER_SYNC)
      expect(result.synced).toBe(20);
      // 5 should be skipped due to cap
      expect(result.skipped).toBeGreaterThanOrEqual(5);
    });

    it("returns correct MIME types for various extensions", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_mime";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/app.py" } },
        origin: "server",
      });
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/style.css" } },
        origin: "server",
      });
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/page.html" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "content", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(3);
      const pyFile = result.files.find(f => f.filename === "app.py");
      const cssFile = result.files.find(f => f.filename === "style.css");
      const htmlFile = result.files.find(f => f.filename === "page.html");
      expect(pyFile?.mime_type).toBe("text/x-python");
      expect(cssFile?.mime_type).toBe("text/css");
      expect(htmlFile?.mime_type).toBe("text/html");
    });

    it("handles provider exec failure gracefully", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_execfail";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/fail.txt" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        // cat fails
        "cat": { stdout: "", stderr: "No such file", exit_code: 1 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(0);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Auto-execute document generation scripts
  // =========================================================================

  describe("auto-execute document generation scripts", () => {
    it("auto-executes .js file that requires docx when Bash was not used", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_autoexec";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/gen.js" } },
        origin: "server",
      });

      const scriptContent = 'const { Document } = require("docx");\nconst doc = new Document({});';
      let nodeExecuted = false;

      const provider: ContainerProvider = {
        name: "docker" as ContainerProvider["name"],
        stripControlChars: false,
        exec: vi.fn(async (_name: string, argv: string[]) => {
          const cmd = argv.join(" ");
          if (cmd.includes("head")) {
            return { stdout: scriptContent, stderr: "", exit_code: 0 };
          }
          if (cmd.includes("npm") && cmd.includes("node")) {
            nodeExecuted = true;
            return { stdout: "Script executed", stderr: "", exit_code: 0 };
          }
          if (cmd.includes("cat")) {
            return { stdout: scriptContent, stderr: "", exit_code: 0 };
          }
          if (cmd.includes("/mnt/session/outputs")) {
            return { stdout: "", stderr: "", exit_code: 0 };
          }
          if (cmd.includes("find")) {
            return { stdout: "", stderr: "", exit_code: 0 };
          }
          return { stdout: "", stderr: "", exit_code: 0 };
        }),
        startExec: vi.fn(async () => ({
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exitCode: Promise.resolve(0),
          kill: vi.fn(),
        })),
        create: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
        list: vi.fn(async () => []),
      } as unknown as ContainerProvider;

      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(nodeExecuted).toBe(true);
      expect(result.autoExecuted.length).toBe(1);
      expect(result.autoExecuted[0].scriptPath).toBe("/home/user/gen.js");
      expect(result.autoExecuted[0].success).toBe(true);
    });

    it("does not auto-execute when Bash was already used", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_noautoexec";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/gen.js" } },
        origin: "server",
      });
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Bash", input: { command: "node gen.js" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: 'const { Document } = require("docx");', stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
        "head": { stdout: 'const { Document } = require("docx");', stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.autoExecuted).toEqual([]);
    });

    it("does not auto-execute scripts without matching library imports", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_nomatch";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/script.js" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: 'const fs = require("fs");', stderr: "", exit_code: 0 },
        "head": { stdout: 'const fs = require("fs");', stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.autoExecuted).toEqual([]);
    });

    it("records failed auto-execution", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_autoexec_fail";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/broken.js" } },
        origin: "server",
      });

      const provider: ContainerProvider = {
        name: "docker" as ContainerProvider["name"],
        stripControlChars: false,
        exec: vi.fn(async (_name: string, argv: string[]) => {
          const cmd = argv.join(" ");
          if (cmd.includes("head")) {
            return { stdout: 'const PDFDocument = require("pdfkit");', stderr: "", exit_code: 0 };
          }
          if (cmd.includes("npm") && cmd.includes("node")) {
            return { stdout: "", stderr: "SyntaxError: Unexpected token", exit_code: 1 };
          }
          if (cmd.includes("cat")) {
            return { stdout: 'const PDFDocument = require("pdfkit");', stderr: "", exit_code: 0 };
          }
          if (cmd.includes("/mnt/session/outputs")) {
            return { stdout: "", stderr: "", exit_code: 0 };
          }
          if (cmd.includes("find")) {
            return { stdout: "", stderr: "", exit_code: 0 };
          }
          return { stdout: "", stderr: "", exit_code: 0 };
        }),
        startExec: vi.fn(async () => ({
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exitCode: Promise.resolve(0),
          kill: vi.fn(),
        })),
        create: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
        list: vi.fn(async () => []),
      } as unknown as ContainerProvider;

      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.autoExecuted.length).toBe(1);
      expect(result.autoExecuted[0].success).toBe(false);
    });
  });

  // =========================================================================
  // Gemini & Pi backend tool names
  // =========================================================================

  describe("multi-backend tool name support", () => {
    it("extracts file paths from Gemini write_file events", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_gemini";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "write_file", input: { file_path: "/workspace/output.py" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "print('hello')", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.files.some(f => f.container_path === "/workspace/output.py")).toBe(true);
    });

    it("extracts file paths from Gemini edit_file events", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_gemini_edit";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "edit_file", input: { path: "/workspace/main.go" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "package main", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.files.some(f => f.container_path === "/workspace/main.go")).toBe(true);
    });

    it("extracts file paths from Pi write/edit events", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_pi";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "write", input: { path: "/workspace/script.rb" } },
        origin: "server",
      });
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "edit", input: { path: "/workspace/config.yml" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "content", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(2);
    });

    it("detects lowercase bash tool name", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_bash_lower";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "write", input: { path: "/home/user/gen.js" } },
        origin: "server",
      });
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "bash", input: { command: "node gen.js" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: 'const { Document } = require("docx");', stderr: "", exit_code: 0 },
        "head": { stdout: 'const { Document } = require("docx");', stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      // sawBash should be true → no auto-execute
      expect(result.autoExecuted).toEqual([]);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("merges discovered paths with extracted paths without duplicates", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_merge";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      // Extract one path from event
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/overlap.txt" } },
        origin: "server",
      });

      // Discovery also finds the same file plus an extra one
      const provider = fakeProvider({
        find: {
          stdout: "/home/user/overlap.txt\n/home/user/extra.txt\n",
          stderr: "", exit_code: 0,
        },
        "cat": { stdout: "content", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      // overlap.txt counted once (from events), extra.txt added from discovery
      expect(result.synced).toBe(2);
    });

    it("works with no events at all (empty session)", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_noevent";
      seedSession(db, sid);

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.files).toEqual([]);
      expect(result.autoExecuted).toEqual([]);
    });

    it("handles filePath input key variants (file_path, filePath, path)", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_variants";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      // file_path variant
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/a.txt" } },
        origin: "server",
      });
      // filePath variant (camelCase)
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { filePath: "/home/user/b.txt" } },
        origin: "server",
      });
      // path variant
      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "file_edit", input: { path: "/home/user/c.txt" } },
        origin: "server",
      });

      const provider = fakeProvider({
        find: { stdout: "", stderr: "", exit_code: 0 },
        "cat": { stdout: "content", stderr: "", exit_code: 0 },
        "/mnt/session/outputs": { stdout: "", stderr: "", exit_code: 0 },
      });
      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      expect(result.synced).toBe(3);
    });

    it("handles provider exec throwing an exception", async () => {
      const { getDb } = await import("../src/db/client");
      const db = getDb();
      const sid = "sess_throw";
      seedSession(db, sid);
      const { appendEvent } = await import("../src/sessions/bus");

      appendEvent(sid, {
        type: "agent.tool_use",
        payload: { name: "Write", input: { file_path: "/home/user/crash.txt" } },
        origin: "server",
      });

      const provider: ContainerProvider = {
        name: "docker" as ContainerProvider["name"],
        stripControlChars: false,
        exec: vi.fn(async (_name: string, argv: string[]) => {
          const cmd = argv.join(" ");
          if (cmd.includes("cat")) {
            throw new Error("Container connection lost");
          }
          if (cmd.includes("/mnt/session/outputs")) {
            return { stdout: "", stderr: "", exit_code: 0 };
          }
          if (cmd.includes("find")) {
            return { stdout: "", stderr: "", exit_code: 0 };
          }
          return { stdout: "", stderr: "", exit_code: 0 };
        }),
        startExec: vi.fn(async () => ({
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exitCode: Promise.resolve(0),
          kill: vi.fn(),
        })),
        create: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
        list: vi.fn(async () => []),
      } as unknown as ContainerProvider;

      const { syncContainerFiles } = await import("../src/sync/container-file-sync");
      const result = await syncContainerFiles({ sessionId: sid, sandboxName: "sb1", provider });

      // Should handle the error gracefully
      expect(result.synced).toBe(0);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
    });
  });
});
