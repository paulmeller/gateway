/**
 * Vercel Sandbox provider.
 *
 * Uses the `@vercel/sandbox` SDK (v1.9.x) to create and manage cloud sandboxes.
 * The SDK is optional — if not installed, a clear error is thrown on first use.
 *
 * Authentication: pass VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID
 * (all three required together) to Sandbox.create(), or use VERCEL_OIDC_TOKEN
 * for Vercel-hosted deployments (via `vercel link`).
 *
 * Container lifecycle:
 *   create → Sandbox.create({ runtime })
 *   exec   → sandbox.runCommand('bash', ['-c', ...])
 *   delete → sandbox.stop()
 *
 * Env vars: VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID,
 *           VERCEL_SANDBOX_RUNTIME (default: "node24")
 */
import type { ContainerProvider, ExecOptions, ExecSession, ProviderSecrets } from "./types";
import { shellEscape } from "./shared";
import { readEnvOrSetting } from "../config";

// Lazy-loaded SDK types matching @vercel/sandbox v1.9.x
// stdout() and stderr() are async methods on CommandFinished, not properties.
type VercelCommandFinished = {
  exitCode: number;
  stdout(opts?: { signal?: AbortSignal }): Promise<string>;
  stderr(opts?: { signal?: AbortSignal }): Promise<string>;
};

type VercelSandbox = {
  sandboxId: string;
  writeFiles(
    files: Array<{ path: string; content: string | Uint8Array; mode?: number }>,
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
  runCommand(
    cmd: string,
    args?: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<VercelCommandFinished>;
  stop(opts?: { blocking?: boolean; signal?: AbortSignal }): Promise<unknown>;
};

type VercelSandboxClass = {
  create(opts?: {
    runtime?: string;
    ports?: number[];
    timeout?: number;
    networkPolicy?: string | object;
    env?: Record<string, string>;
    signal?: AbortSignal;
    // Credential passthrough — all three must be provided together.
    // If omitted, the SDK falls back to VERCEL_OIDC_TOKEN / vercel link.
    token?: string;
    teamId?: string;
    projectId?: string;
  }): Promise<VercelSandbox>;
  list(opts?: {
    projectId?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
};

let SandboxClass: VercelSandboxClass | null = null;

async function loadSdk(): Promise<VercelSandboxClass> {
  if (SandboxClass) return SandboxClass;
  try {
    // @ts-ignore — optional dependency, may not be installed
    const mod: any = await import("@vercel/sandbox");
    SandboxClass = (mod.Sandbox ?? mod.default) as VercelSandboxClass;
    if (!SandboxClass?.create) {
      throw new Error("Sandbox.create not found in @vercel/sandbox exports");
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
        "Vercel provider requires the @vercel/sandbox package. Install it with: npm install @vercel/sandbox",
      );
    }
    throw err;
  }
}

// HMR-safe sandbox instance map
type GlobalWithVercel = typeof globalThis & { __caVercelSandboxes?: Map<string, VercelSandbox> };
const g = globalThis as GlobalWithVercel;
if (!g.__caVercelSandboxes) g.__caVercelSandboxes = new Map();
const sandboxes = g.__caVercelSandboxes;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const vercelProvider: ContainerProvider = {
  name: "vercel",
  stripControlChars: false,

  async checkAvailability(secrets?: ProviderSecrets) {
    try { await loadSdk(); } catch {
      return { available: false, message: "Vercel Sandbox requires the @vercel/sandbox package. Install with: npm install @vercel/sandbox" };
    }
    // Auth is via env vars read by the SDK automatically.
    const hasToken = secrets?.VERCEL_TOKEN ?? readEnvOrSetting("VERCEL_TOKEN");
    const hasOidc = process.env.VERCEL_OIDC_TOKEN;
    if (!hasToken && !hasOidc) {
      return { available: false, message: "VERCEL_TOKEN required — add to vault or .env (or set VERCEL_OIDC_TOKEN)" };
    }
    return { available: true };
  },

  async create({ name, secrets }) {
    const Sandbox = await loadSdk();
    const runtime = process.env.VERCEL_SANDBOX_RUNTIME ?? "node24";
    // Pass credentials directly if all three are available.
    // The SDK also supports VERCEL_OIDC_TOKEN / vercel link as fallback.
    const sandbox = await Sandbox.create({
      runtime,
      token: secrets?.VERCEL_TOKEN ?? readEnvOrSetting("VERCEL_TOKEN"),
      teamId: secrets?.VERCEL_TEAM_ID ?? readEnvOrSetting("VERCEL_TEAM_ID"),
      projectId: secrets?.VERCEL_PROJECT_ID ?? readEnvOrSetting("VERCEL_PROJECT_ID"),
    });
    sandboxes.set(name, sandbox);
  },

  async delete(name) {
    const sandbox = sandboxes.get(name);
    if (!sandbox) return;
    try {
      await sandbox.stop();
    } catch {
      // Best-effort — sandbox may already be gone
    }
    sandboxes.delete(name);
  },

  async list(opts) {
    // In-memory map only. Sandbox.list() exists in the SDK but returns
    // paginated summaries (not live Sandbox instances), so we can't use
    // it to reconnect. After a server restart, previously-created sandboxes
    // will not appear here — callers re-create on demand.
    const prefix = opts?.prefix ?? "ca-sess-";
    return Array.from(sandboxes.keys())
      .filter((n) => n.startsWith(prefix))
      .map((name) => ({ name }));
  },

  async exec(name, argv, opts) {
    const sandbox = sandboxes.get(name);
    if (!sandbox) throw new Error(`Vercel sandbox not found: ${name}`);

    const cmd = argv.map((a) => shellEscape(a)).join(" ");

    // Write stdin to a unique temp file if provided, then run cmd reading from it
    if (opts?.stdin) {
      const stdinPath = `/tmp/_stdin_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await sandbox.writeFiles([{ path: stdinPath, content: opts.stdin }]);
      const result = await sandbox.runCommand("bash", [
        "-c",
        `cat ${shellEscape(stdinPath)} | ${cmd} ; rm -f ${shellEscape(stdinPath)}`,
      ]);
      return {
        stdout: await result.stdout(),
        stderr: await result.stderr(),
        exit_code: result.exitCode,
      };
    }

    const result = await sandbox.runCommand("bash", ["-c", cmd]);
    return {
      stdout: await result.stdout(),
      stderr: await result.stderr(),
      exit_code: result.exitCode,
    };
  },

  async startExec(name, opts) {
    const sandbox = sandboxes.get(name);
    if (!sandbox) throw new Error(`Vercel sandbox not found: ${name}`);

    const cmd = opts.argv.map((a) => shellEscape(a)).join(" ");

    // Write stdin to a unique temp file if provided
    let stdinPath: string | undefined;
    if (opts.stdin) {
      stdinPath = `/tmp/_stdin_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await sandbox.writeFiles([{ path: stdinPath, content: opts.stdin }]);
    }

    const fullCmd = stdinPath
      ? `cat ${shellEscape(stdinPath)} | ${cmd} ; rm -f ${shellEscape(stdinPath)}`
      : cmd;

    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array>;

    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    const resultPromise = sandbox.runCommand("bash", ["-c", fullCmd]);

    const exit = resultPromise.then(async (result) => {
      try {
        const out = await result.stdout();
        streamController.enqueue(encoder.encode(out));
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
        // Vercel SDK doesn't support killing individual commands
      },
    };
  },
};
