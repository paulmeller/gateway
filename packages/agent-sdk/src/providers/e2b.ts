/**
 * E2B sandbox provider.
 *
 * Uses the `e2b` SDK (v2) to create and manage cloud sandboxes.
 * The SDK communicates via ConnectRPC over HTTP for sandbox commands
 * and REST for management API calls.
 *
 * Container lifecycle:
 *   create → Sandbox.create(template, { apiKey })
 *   exec   → sandbox.commands.run(cmd)
 *   delete → sandbox.kill()
 *
 * Env vars: E2B_API_KEY (required), E2B_TEMPLATE (default: "base")
 */
import type { ContainerProvider, ProviderSecrets } from "./types";
import { shellEscape } from "./shared";

// Lazy-loaded SDK types matching e2b@2.x
type E2BSandbox = {
  sandboxId: string;
  commands: {
    run(
      cmd: string,
      opts?: {
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
      },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  files: {
    write(path: string, data: string | ArrayBuffer | Blob): Promise<unknown>;
  };
  kill(): Promise<void>;
};

type E2BSandboxStatic = {
  create(template: string, opts?: {
    apiKey?: string;
    timeoutMs?: number;
    envs?: Record<string, string>;
  }): Promise<E2BSandbox>;
  connect(sandboxId: string, opts?: {
    apiKey?: string;
  }): Promise<E2BSandbox>;
  kill(sandboxId: string, opts?: {
    apiKey?: string;
  }): Promise<boolean>;
};

let SandboxClass: E2BSandboxStatic | null = null;

async function loadSdk(): Promise<E2BSandboxStatic> {
  if (SandboxClass) return SandboxClass;
  try {
    // e2b@2.x exports Sandbox directly at top level
    const mod: any = await import("e2b");
    SandboxClass = (mod.Sandbox ?? mod.default) as E2BSandboxStatic;
    if (!SandboxClass?.create) {
      throw new Error("Sandbox.create not found in e2b exports");
    }
    return SandboxClass;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("Cannot find module") ||
        err.message.includes("MODULE_NOT_FOUND") ||
        err.message.includes("ERR_MODULE_NOT_FOUND"))
    ) {
      throw new Error(
        "E2B provider requires the e2b package. Install it with: npm install e2b",
      );
    }
    throw err;
  }
}

// HMR-safe sandbox instance map
type GlobalWithE2B = typeof globalThis & { __caE2BSandboxes?: Map<string, E2BSandbox> };
const g = globalThis as GlobalWithE2B;
if (!g.__caE2BSandboxes) g.__caE2BSandboxes = new Map();
const sandboxes = g.__caE2BSandboxes;

const DEFAULT_TEMPLATE = process.env.E2B_TEMPLATE ?? "base";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const e2bProvider: ContainerProvider = {
  name: "e2b",
  stripControlChars: false,

  async checkAvailability(secrets?: ProviderSecrets) {
    try { await loadSdk(); } catch {
      return { available: false, message: "E2B requires the e2b package. Install with: npm install e2b" };
    }
    if (!(secrets?.E2B_API_KEY ?? process.env.E2B_API_KEY)) {
      return { available: false, message: "E2B_API_KEY required — add to vault or .env" };
    }
    return { available: true };
  },

  async create({ name, secrets }) {
    const Sandbox = await loadSdk();
    const apiKey = secrets?.E2B_API_KEY ?? process.env.E2B_API_KEY;
    if (!apiKey) throw new Error("E2B_API_KEY required — add to vault or .env");

    const sandbox = await Sandbox.create(DEFAULT_TEMPLATE, {
      apiKey,
      timeoutMs: 300_000,
    });
    sandboxes.set(name, sandbox);
  },

  async delete(name) {
    const sandbox = sandboxes.get(name);
    if (!sandbox) return;
    try {
      await sandbox.kill();
    } catch {
      // Best-effort — sandbox may already be gone
    }
    sandboxes.delete(name);
  },

  async list(opts) {
    const prefix = opts?.prefix ?? "ca-sess-";
    return Array.from(sandboxes.keys())
      .filter((n) => n.startsWith(prefix))
      .map((name) => ({ name }));
  },

  async exec(name, argv, opts) {
    const sandbox = sandboxes.get(name);
    if (!sandbox) throw new Error(`E2B sandbox not found: ${name}`);

    const cmd = argv.map((a) => shellEscape(a)).join(" ");

    if (opts?.stdin) {
      // Write stdin to a temp file, pipe it into the command, then clean up.
      // Avoids shell arg length limits from echo piping.
      const stdinPath = `/tmp/_stdin_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await sandbox.files.write(stdinPath, opts.stdin);
      const result = await sandbox.commands.run(
        `cat ${stdinPath} | ${cmd} ; rm -f ${stdinPath}`,
        { timeoutMs: opts?.timeoutMs },
      );
      return { stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode };
    }

    const result = await sandbox.commands.run(cmd, { timeoutMs: opts?.timeoutMs });
    return { stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode };
  },

  async startExec(name, opts) {
    const sandbox = sandboxes.get(name);
    if (!sandbox) throw new Error(`E2B sandbox not found: ${name}`);

    const cmd = opts.argv.map((a) => shellEscape(a)).join(" ");

    const fullCmd = opts.stdin
      ? await (async () => {
          const stdinPath = `/tmp/_stdin_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          await sandbox.files.write(stdinPath, opts.stdin!);
          return `cat ${stdinPath} | ${cmd} ; rm -f ${stdinPath}`;
        })()
      : cmd;

    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array>;

    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    const resultPromise = sandbox.commands.run(fullCmd, {
      onStdout: (data: string) => {
        try {
          streamController.enqueue(encoder.encode(data));
        } catch {
          // Stream may be closed
        }
      },
      onStderr: (_data: string) => {
        // stderr is not streamed to stdout
      },
      timeoutMs: opts.timeoutMs,
    });

    const exit = resultPromise.then((result) => {
      try {
        streamController.close();
      } catch {
        // Already closed
      }
      return { code: result.exitCode };
    }).catch((err) => {
      try {
        streamController.error(err);
      } catch {
        // Already closed
      }
      throw err;
    });

    return {
      stdout,
      exit,
      async kill() {
        // E2B doesn't support killing individual commands
      },
    };
  },
};
