/**
 * Unit tests for `gateway db reset`.
 *
 * Scope:
 *   - Pure helpers (resolveDbPath, isLoopbackUrl, fileSize, dirSize, fmtBytes)
 *   - planReset safety-check decision tree (TURSO_URL, --remote, base-url
 *     loopback, live server probe, target enumeration, noop-when-empty)
 *   - performReset file IO (correct unlink order, --include-files, ENOENT
 *     tolerance, EBUSY propagation)
 *
 * We intentionally do NOT test doReset (the CLI action wrapper) — it's a
 * thin orchestration layer over the tested functions plus console/prompt
 * IO. Those paths are verified manually (see PR).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolveDbPath,
  isLoopbackUrl,
  fileSize,
  dirSize,
  fmtBytes,
  planReset,
  performReset,
  type ResetPlan,
} from "../src/commands/db";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gateway-reset-test-"));
}

function touch(p: string, size = 32): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size));
}

const noProbe = async () => false;
const aliveProbe = async () => true;

// ─── Pure helpers ─────────────────────────────────────────────────────────

describe("resolveDbPath", () => {
  it("returns absolute path unchanged", () => {
    expect(resolveDbPath("/tmp/cwd", "/abs/foo.db")).toBe("/abs/foo.db");
  });

  it("resolves relative path against the given cwd", () => {
    expect(resolveDbPath("/tmp/cwd", "./data/x.db")).toBe("/tmp/cwd/data/x.db");
  });

  it("defaults to ./data/managed-agents.db under cwd when env is null", () => {
    expect(resolveDbPath("/tmp/cwd", null)).toBe("/tmp/cwd/data/managed-agents.db");
  });
});

describe("isLoopbackUrl", () => {
  it.each([
    ["http://localhost:4000", true],
    ["http://127.0.0.1:3000", true],
    ["http://[::1]/foo", true],
    ["http://0.0.0.0:8080", true],
    ["https://example.com", false],
    ["http://api.agentstep.com", false],
    ["not a url", false],
    ["http://10.0.0.1", false],
  ])("%s → %s", (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });
});

describe("fmtBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [2_048, "2.0 KB"],
    [1_048_576, "1.00 MB"],
    [5_242_880, "5.00 MB"],
  ])("%i → %s", (bytes, expected) => {
    expect(fmtBytes(bytes)).toBe(expected);
  });
});

describe("fileSize / dirSize", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("fileSize returns 0 when file is missing", () => {
    expect(fileSize(path.join(tmp, "nope.db"))).toBe(0);
  });

  it("fileSize returns actual byte count for existing file", () => {
    const p = path.join(tmp, "x");
    touch(p, 100);
    expect(fileSize(p)).toBe(100);
  });

  it("dirSize returns 0 for missing dir", () => {
    expect(dirSize(path.join(tmp, "nope"))).toBe(0);
  });

  it("dirSize sums files recursively including nested dirs", () => {
    touch(path.join(tmp, "a"), 10);
    touch(path.join(tmp, "sub", "b"), 20);
    touch(path.join(tmp, "sub", "deep", "c"), 30);
    expect(dirSize(tmp)).toBe(60);
  });
});

// ─── planReset — safety-check decision tree ───────────────────────────────

describe("planReset", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    dbPath = path.join(tmp, "test.db");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const baseInput = () => ({
    opts: {},
    baseUrl: "http://localhost:3000",
    baseUrlFromConfig: false,
    probeUrls: ["http://localhost:3000", "http://localhost:4000"],
    dbPath,
  });

  it("refuses when TURSO_URL is set", async () => {
    const plan = await planReset({ ...baseInput(), tursoUrl: "libsql://x.turso.io" }, noProbe);
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") throw new Error("unreachable");
    expect(plan.reason).toMatch(/TURSO_URL/);
  });

  it("refuses when --remote is passed, even against a local probe miss", async () => {
    const plan = await planReset(
      { ...baseInput(), remoteFlag: "http://remote.example.com" },
      noProbe,
    );
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") throw new Error("unreachable");
    expect(plan.reason).toMatch(/--remote/);
  });

  it("refuses when configured base-url points to a non-loopback host", async () => {
    const plan = await planReset(
      {
        ...baseInput(),
        baseUrl: "https://api.agentstep.com",
        baseUrlFromConfig: true,
      },
      noProbe,
    );
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") throw new Error("unreachable");
    expect(plan.reason).toMatch(/non-loopback/);
  });

  it("refuses when non-loopback base-url comes from env, not config (baseUrlFromConfig still true)", async () => {
    // Regression: the doReset wrapper must set baseUrlFromConfig=true when
    // GATEWAY_BASE_URL is in env — otherwise a production URL in env slips
    // past this check silently.
    const plan = await planReset(
      {
        ...baseInput(),
        baseUrl: "https://prod.example.com",
        baseUrlFromConfig: true, // what the wrapper computes from env OR config
      },
      noProbe,
    );
    expect(plan.kind).toBe("refuse");
  });

  it("allows a custom localhost port in base-url (no false positive)", async () => {
    // This is the architect's stated bug: the CLI's default remote-detection
    // heuristic refuses when base-url is set to a non-default value, even if
    // that value is localhost. planReset must be smarter.
    touch(dbPath, 4096);
    const plan = await planReset(
      {
        ...baseInput(),
        baseUrl: "http://localhost:4001",
        baseUrlFromConfig: true,
      },
      noProbe,
    );
    expect(plan.kind).toBe("proceed");
  });

  it("refuses when a probe reports the server is alive", async () => {
    const plan = await planReset(baseInput(), aliveProbe);
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") throw new Error("unreachable");
    expect(plan.reason).toMatch(/gateway server is responding/);
  });

  it("returns noop when DB files do not exist and --include-files is off", async () => {
    const plan = await planReset(baseInput(), noProbe);
    expect(plan.kind).toBe("noop");
  });

  it("returns proceed when DB files exist", async () => {
    touch(dbPath, 4096);
    touch(`${dbPath}-wal`, 8192);
    touch(`${dbPath}-shm`, 32768);

    const plan = await planReset(baseInput(), noProbe);
    expect(plan.kind).toBe("proceed");
    if (plan.kind !== "proceed") throw new Error("unreachable");
    expect(plan.targets.present).toHaveLength(3);
    expect(plan.targets.present).toContain(dbPath);
    expect(plan.targets.present).toContain(`${dbPath}-wal`);
    expect(plan.targets.present).toContain(`${dbPath}-shm`);
    expect(plan.targets.bytes).toBe(4096 + 8192 + 32768);
    expect(plan.targets.wipeFiles).toBe(false);
  });

  it("returns proceed when DB is absent but --include-files + files dir has content", async () => {
    const filesDir = path.join(tmp, "files");
    touch(path.join(filesDir, "a.txt"), 42);

    const plan = await planReset(
      { ...baseInput(), opts: { includeFiles: true } },
      noProbe,
    );
    expect(plan.kind).toBe("proceed");
    if (plan.kind !== "proceed") throw new Error("unreachable");
    expect(plan.targets.wipeFiles).toBe(true);
    expect(plan.targets.present).toHaveLength(0);
    expect(plan.targets.bytes).toBe(42);
  });

  it("probe is awaited for each url and short-circuits on first hit", async () => {
    const calls: string[] = [];
    const probe = async (url: string) => {
      calls.push(url);
      return url.endsWith(":4000");
    };
    touch(dbPath, 100);
    const plan = await planReset(baseInput(), probe);
    expect(plan.kind).toBe("refuse");
    expect(calls).toEqual([
      "http://localhost:3000",
      "http://localhost:4000",
    ]);
  });
});

// ─── performReset — IO ────────────────────────────────────────────────────

describe("performReset", () => {
  let tmp: string;
  let dbPath: string;
  beforeEach(() => {
    tmp = makeTmpDir();
    dbPath = path.join(tmp, "test.db");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function mkTargets(wipeFiles = false): (ResetPlan & { kind: "proceed" })["targets"] {
    return {
      dbPath,
      walPath: `${dbPath}-wal`,
      shmPath: `${dbPath}-shm`,
      filesDir: path.join(tmp, "files"),
      present: [],
      wipeFiles,
      bytes: 0,
    };
  }

  it("removes all three DB files and counts removals", () => {
    touch(dbPath);
    touch(`${dbPath}-wal`);
    touch(`${dbPath}-shm`);

    const res = performReset(mkTargets());
    expect(res.removed).toBe(3);
    expect(res.wipedFiles).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("tolerates ENOENT — any subset of files can be missing", () => {
    // Only the main DB exists; -wal and -shm missing.
    touch(dbPath);
    const res = performReset(mkTargets());
    expect(res.removed).toBe(1);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("returns 0 removals when nothing exists (all ENOENT)", () => {
    const res = performReset(mkTargets());
    expect(res.removed).toBe(0);
  });

  it("unlinks in order: -wal, -shm, main DB", () => {
    // Wrap fs.unlinkSync to record the call order.
    const real = fs.unlinkSync;
    const calls: string[] = [];
    const spy = ((p: string) => {
      calls.push(path.basename(p));
      real(p);
    }) as typeof fs.unlinkSync;
    (fs as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = spy;
    try {
      touch(dbPath);
      touch(`${dbPath}-wal`);
      touch(`${dbPath}-shm`);
      performReset(mkTargets());
      expect(calls).toEqual(["test.db-wal", "test.db-shm", "test.db"]);
    } finally {
      (fs as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = real;
    }
  });

  it("propagates EBUSY so the caller can surface a clear error", () => {
    const real = fs.unlinkSync;
    (fs as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = ((_p: string) => {
      const err: NodeJS.ErrnoException = new Error("busy");
      err.code = "EBUSY";
      throw err;
    }) as typeof fs.unlinkSync;
    try {
      touch(dbPath);
      expect(() => performReset(mkTargets())).toThrow(/busy/);
    } finally {
      (fs as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = real;
    }
  });

  it("wipes and recreates files/ when wipeFiles=true", () => {
    const filesDir = path.join(tmp, "files");
    touch(path.join(filesDir, "nested", "a.txt"), 100);
    touch(path.join(filesDir, "b.bin"), 50);

    const res = performReset({ ...mkTargets(true), filesDir });
    expect(res.wipedFiles).toBe(true);
    expect(fs.existsSync(filesDir)).toBe(true);
    expect(fs.readdirSync(filesDir)).toEqual([]);
  });

  it("does not touch files/ when wipeFiles=false", () => {
    const filesDir = path.join(tmp, "files");
    touch(path.join(filesDir, "a.txt"), 100);
    touch(dbPath);

    performReset({ ...mkTargets(false), filesDir });
    expect(fs.existsSync(filesDir)).toBe(true);
    expect(fs.readFileSync(path.join(filesDir, "a.txt")).length).toBe(100);
  });
});
