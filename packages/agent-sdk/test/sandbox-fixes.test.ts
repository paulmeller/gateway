import { describe, it, expect } from "vitest";

/**
 * Unit tests for fixes added in 0.4.14:
 * - Title sanitization
 * - File sync path handling (filePath camelCase, root CWD, blocklist)
 * - Pool register dedup
 */

describe("Title sanitization", () => {
  // Extracted logic from driver.ts for testability
  function sanitizeTitle(raw: string): string {
    return raw
      .replace(/[\x00-\x1F\x7F\u200B-\u200F\u2028-\u202F\uFEFF]/g, "")
      .replace(/^Image(?=[A-Z])/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  }

  it("strips control characters", () => {
    expect(sanitizeTitle("hello\x00world\x1F")).toBe("helloworld");
  });

  it("strips zero-width chars", () => {
    expect(sanitizeTitle("hello\u200Bworld\uFEFF")).toBe("helloworld");
  });

  it("removes Image prefix before capital letter", () => {
    expect(sanitizeTitle("ImageHow to Build Your First AI Agent")).toBe("How to Build Your First AI Agent");
  });

  it("keeps Image when not followed by capital", () => {
    expect(sanitizeTitle("Image processing tips")).toBe("Image processing tips");
  });

  it("collapses whitespace", () => {
    expect(sanitizeTitle("  hello   world  ")).toBe("hello world");
  });

  it("truncates to 60 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeTitle(long)).toHaveLength(60);
  });
});

describe("File sync path handling", () => {
  // Extracted from container-file-sync.ts
  const BLOCKED_PREFIXES = [
    "/proc/", "/sys/", "/dev/", "/etc/", "/bin/", "/sbin/",
    "/usr/bin/", "/usr/sbin/", "/usr/lib/", "/var/run/", "/var/log/",
  ];

  function isPathSafe(p: string): boolean {
    if (!p.startsWith("/")) return false;
    if (p.includes("..")) return false;
    return !BLOCKED_PREFIXES.some((prefix) => p.startsWith(prefix));
  }

  function resolvePath(filePath: string): string {
    return filePath.startsWith("/") ? filePath : `/${filePath}`;
  }

  it("resolves relative path to root /", () => {
    expect(resolvePath("hello.py")).toBe("/hello.py");
  });

  it("keeps absolute path as-is", () => {
    expect(resolvePath("/home/user/file.py")).toBe("/home/user/file.py");
  });

  it("allows files at filesystem root", () => {
    expect(isPathSafe("/hello.py")).toBe(true);
  });

  it("allows /home/ paths", () => {
    expect(isPathSafe("/home/user/test.py")).toBe(true);
  });

  it("allows /root/ paths", () => {
    expect(isPathSafe("/root/test.py")).toBe(true);
  });

  it("blocks /proc/", () => {
    expect(isPathSafe("/proc/1/cmdline")).toBe(false);
  });

  it("blocks /etc/", () => {
    expect(isPathSafe("/etc/passwd")).toBe(false);
  });

  it("blocks /dev/", () => {
    expect(isPathSafe("/dev/null")).toBe(false);
  });

  it("blocks path traversal", () => {
    expect(isPathSafe("/home/../etc/passwd")).toBe(false);
  });

  it("rejects non-absolute paths", () => {
    expect(isPathSafe("relative/path")).toBe(false);
  });
});

describe("Pool register dedup", () => {
  it("does not duplicate entries on double register", async () => {
    // Dynamic import to get fresh pool state
    const pool = await import("../src/containers/pool");

    const entry = {
      sandboxName: "test-dedup-sandbox",
      envId: "env-test-dedup",
      sessionId: "sess-test-dedup",
      createdAt: Date.now(),
    };

    pool.register(entry);
    pool.register(entry); // register again

    expect(pool.countInEnv("env-test-dedup")).toBe(1);

    // Cleanup
    pool.unregister("sess-test-dedup");
    expect(pool.countInEnv("env-test-dedup")).toBe(0);
  });
});

describe("wrapProviderWithSecrets", () => {
  // Regression for: sessions with `resources` failing on first turn with
  // "SPRITE_TOKEN required" when the token is in the vault but not in
  // process.env / settings. The driver re-provisions resources after
  // `acquireForFirstTurn` and previously used an unwrapped provider that
  // dropped vault secrets on the floor.
  function makeFakeProvider(): {
    provider: import("../src/providers/types").ContainerProvider;
    calls: {
      exec: Array<{ name: string; argv: string[]; opts?: Record<string, unknown> }>;
      startExec: Array<{ name: string; opts: Record<string, unknown> }>;
      create: Array<Record<string, unknown>>;
      delete: Array<{ name: string; secrets?: Record<string, string> }>;
    };
  } {
    const calls = {
      exec: [] as Array<{ name: string; argv: string[]; opts?: Record<string, unknown> }>,
      startExec: [] as Array<{ name: string; opts: Record<string, unknown> }>,
      create: [] as Array<Record<string, unknown>>,
      delete: [] as Array<{ name: string; secrets?: Record<string, string> }>,
    };
    const provider: import("../src/providers/types").ContainerProvider = {
      name: "sprites",
      stripControlChars: false,
      async create(opts) { calls.create.push(opts as Record<string, unknown>); },
      async delete(name, secrets) { calls.delete.push({ name, secrets }); },
      async list() { return []; },
      async exec(name, argv, opts) {
        calls.exec.push({ name, argv, opts: opts as Record<string, unknown> | undefined });
        return { stdout: "", stderr: "", exit_code: 0 };
      },
      startExec(name, opts) {
        calls.startExec.push({ name, opts: opts as unknown as Record<string, unknown> });
        return Promise.resolve({
          stdout: new ReadableStream(),
          exit: Promise.resolve({ code: 0 }),
          async kill() {},
        });
      },
    };
    return { provider, calls };
  }

  it("threads secrets into exec/startExec/create/delete", async () => {
    const { wrapProviderWithSecrets } = await import("../src/containers/lifecycle");
    const { provider, calls } = makeFakeProvider();
    const wrapped = wrapProviderWithSecrets(provider, { SPRITE_TOKEN: "vault-tok" });

    await wrapped.exec("box", ["mkdir", "-p", "/x"]);
    expect(calls.exec[0].opts?.secrets).toEqual({ SPRITE_TOKEN: "vault-tok" });

    await wrapped.startExec("box", { argv: ["echo"] });
    expect((calls.startExec[0].opts as { secrets?: unknown }).secrets).toEqual({
      SPRITE_TOKEN: "vault-tok",
    });

    await wrapped.create({ name: "box" });
    expect((calls.create[0] as { secrets?: unknown }).secrets).toEqual({
      SPRITE_TOKEN: "vault-tok",
    });

    await wrapped.delete("box");
    expect(calls.delete[0].secrets).toEqual({ SPRITE_TOKEN: "vault-tok" });
  });

  it("returns the original provider when secrets are empty or undefined", async () => {
    const { wrapProviderWithSecrets } = await import("../src/containers/lifecycle");
    const { provider } = makeFakeProvider();
    expect(wrapProviderWithSecrets(provider, undefined)).toBe(provider);
    expect(wrapProviderWithSecrets(provider, {})).toBe(provider);
  });

  it("preserves caller-provided secrets on delete (caller wins)", async () => {
    const { wrapProviderWithSecrets } = await import("../src/containers/lifecycle");
    const { provider, calls } = makeFakeProvider();
    const wrapped = wrapProviderWithSecrets(provider, { SPRITE_TOKEN: "default" });
    await wrapped.delete("box", { SPRITE_TOKEN: "explicit" });
    expect(calls.delete[0].secrets).toEqual({ SPRITE_TOKEN: "explicit" });
  });
});
