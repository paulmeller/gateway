/**
 * Shared CLI provider factory.
 *
 * Extracts the common spawn-and-collect, one-shot exec, and streaming exec
 * patterns that were duplicated across docker, podman, apple-container, and
 * apple-firecracker providers.
 *
 * Each provider supplies a thin config object describing its CLI binary name,
 * argument shapes, and any custom behaviour (e.g. mvm's pool check).
 * The factory returns a complete `ContainerProvider`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import type {
  AvailabilityResult,
  ContainerProvider,
  ExecOptions,
  ExecSession,
  ProviderName,
  ProviderSecrets,
} from "./types";

// ---------------------------------------------------------------------------
// Config interface — each CLI provider fills this in
// ---------------------------------------------------------------------------

export interface CliProviderConfig {
  /** Provider name for the registry (e.g. "docker", "podman"). */
  name: ProviderName;

  /** The CLI binary to spawn (e.g. "docker", "podman", "container", "mvm"). */
  binary: string;

  /** Whether to strip control chars from stdout (always false for CLI providers). */
  stripControlChars?: boolean;

  /**
   * Build the argv for creating a container/VM.
   * Return an array of step arrays — each step is run sequentially via cliRun.
   * e.g. docker returns [["create", "--name", n, img, "sleep", "infinity"], ["start", n]]
   */
  createSteps(name: string): string[][];

  /**
   * Optional fire-and-forget work after create completes (e.g. V8 cache warmup).
   * Receives a `runExec` helper bound to the provider's one-shot exec.
   */
  postCreate?(
    name: string,
    runExec: (
      argv: string[],
      stdin?: string,
      timeoutMs?: number,
    ) => Promise<{ stdout: string; stderr: string; exit_code: number }>,
  ): void;

  /** Build the argv for deleting a container/VM (e.g. ["rm", "-f", name]). */
  deleteArgs(name: string): string[];

  /** Build the argv for exec (e.g. ["exec", "-i", name, ...argv]). */
  execArgs(name: string, argv: string[]): string[];

  /**
   * Build the argv for listing containers/VMs.
   * `prefix` defaults to "ca-sess-" if omitted by the caller.
   */
  listArgs(prefix: string): string[];

  /** Parse list output into container names. */
  parseList(stdout: string, prefix: string): string[];

  /**
   * Custom availability check. If omitted, a default check using
   * `checkCmd` / `checkFailMsg` is used.
   */
  checkAvailability?(): Promise<AvailabilityResult>;

  /** Simple check: argv to run (e.g. ["version", "--format", "..."]). */
  checkCmd?: string[];

  /** Timeout for the availability check command (default 3000). */
  checkTimeoutMs?: number;

  /** Map an error message to a user-facing message. */
  checkFailMsg?(msg: string): string;
}

// ---------------------------------------------------------------------------
// Helpers shared by all CLI providers
// ---------------------------------------------------------------------------

/**
 * Gracefully kill a process: SIGTERM, then escalate to SIGKILL after 3 s.
 * Returns the escalation timer so callers can clear it on process exit.
 */
function killWithEscalation(proc: ChildProcess): NodeJS.Timeout {
  proc.kill("SIGTERM");
  return setTimeout(() => {
    if (!proc.killed) proc.kill("SIGKILL");
  }, 3000);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCliProvider(cfg: CliProviderConfig): ContainerProvider {
  const { binary, name } = cfg;

  // -- cliRun: spawn binary, collect stdout/stderr, handle timeout ----------
  function cliRun(
    args: string[],
    opts?: { stdin?: string; timeoutMs?: number },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (buf: Buffer) => {
        stdout += buf.toString();
      });
      proc.stderr?.on("data", (buf: Buffer) => {
        stderr += buf.toString();
      });

      if (opts?.stdin) {
        proc.stdin?.write(opts.stdin);
      }
      proc.stdin?.end();

      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            proc.kill("SIGKILL");
            reject(
              new Error(
                `${binary} command timed out after ${opts.timeoutMs}ms`,
              ),
            );
          }, opts.timeoutMs)
        : null;

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(
              `${binary} ${args[0]} failed (${code}): ${stderr.trim()}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      });

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }

  // -- execOneShot: run argv in container, wait for exit, return output ------
  function execOneShot(
    containerName: string,
    argv: string[],
    stdin?: string,
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; exit_code: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(binary, cfg.execArgs(containerName, argv), {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (buf: Buffer) => {
        stdout += buf.toString();
      });
      proc.stderr?.on("data", (buf: Buffer) => {
        stderr += buf.toString();
      });

      if (stdin) {
        proc.stdin?.write(stdin);
      }
      proc.stdin?.end();

      const timer = timeoutMs
        ? setTimeout(() => {
            proc.kill("SIGKILL");
            reject(
              new Error(`${binary} exec timed out after ${timeoutMs}ms`),
            );
          }, timeoutMs)
        : null;

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, exit_code: code ?? 1 });
      });

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }

  // -- execStreaming: run argv, stream stdout via ReadableStream --------------
  function execStreaming(
    containerName: string,
    opts: ExecOptions,
  ): ExecSession {
    const args = cfg.execArgs(containerName, opts.argv);
    if (process.env.DEBUG_NDJSON) {
      console.log(`[exec] ${binary} ${args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`);
      if (opts.stdin) console.log(`[exec] stdin: ${opts.stdin.slice(0, 200)}...`);
    }
    const proc = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Capture stderr for debugging
    let stderrBuf = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    // Pipe stdin
    if (opts.stdin) {
      proc.stdin?.write(opts.stdin);
    }
    proc.stdin?.end();

    // Convert Node Readable to Web ReadableStream
    const stdout = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;

    // Exit promise
    let exitResolve: (v: { code: number }) => void;
    let exitReject: (e: unknown) => void;
    const exit = new Promise<{ code: number }>((res, rej) => {
      exitResolve = res;
      exitReject = rej;
    });

    // Track escalation timer so we can clear it on exit
    let escalationTimer: NodeJS.Timeout | null = null;

    proc.on("close", (code) => {
      if (escalationTimer) clearTimeout(escalationTimer);
      if (process.env.DEBUG_NDJSON && code !== 0 && stderrBuf) {
        console.log(`[exec] exit ${code}, stderr: ${stderrBuf.slice(0, 500)}`);
      }
      exitResolve({ code: code ?? 1 });
    });
    proc.on("error", (err) => {
      if (escalationTimer) clearTimeout(escalationTimer);
      exitReject(err);
    });

    // Timeout
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        exitReject(
          new Error(`${binary} exec timed out after ${opts.timeoutMs}ms`),
        );
      }, opts.timeoutMs);
    }
    // Clean up timer on exit
    exit.finally(() => {
      if (timer) clearTimeout(timer);
    });

    // Link caller's abort signal
    if (opts.signal) {
      if (opts.signal.aborted) {
        escalationTimer = killWithEscalation(proc);
      } else {
        opts.signal.addEventListener(
          "abort",
          () => {
            escalationTimer = killWithEscalation(proc);
          },
          { once: true },
        );
      }
    }

    return {
      stdout,
      exit,
      async kill() {
        escalationTimer = killWithEscalation(proc);
      },
    };
  }

  // -- Build the ContainerProvider -------------------------------------------
  const provider: ContainerProvider = {
    name,
    stripControlChars: cfg.stripControlChars ?? false,

    async checkAvailability(_secrets?: ProviderSecrets) {
      // Delegate to custom check if provided
      if (cfg.checkAvailability) {
        return cfg.checkAvailability();
      }
      // Default: run checkCmd
      if (cfg.checkCmd) {
        try {
          await cliRun(cfg.checkCmd, {
            timeoutMs: cfg.checkTimeoutMs ?? 3000,
          });
          return { available: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const failMsg = cfg.checkFailMsg
            ? cfg.checkFailMsg(msg)
            : `${binary} is not available: ${msg}`;
          return { available: false, message: failMsg };
        }
      }
      return { available: true };
    },

    async create({ name: containerName }) {
      const steps = cfg.createSteps(containerName);
      for (const step of steps) {
        await cliRun(step, { timeoutMs: 60_000 });
      }
      if (cfg.postCreate) {
        cfg.postCreate(
          containerName,
          (argv, stdin, timeoutMs) =>
            execOneShot(containerName, argv, stdin, timeoutMs),
        );
      }
    },

    async delete(containerName) {
      await cliRun(cfg.deleteArgs(containerName)).catch(() => {
        // Best-effort — container may already be gone
      });
    },

    async list(opts) {
      try {
        const prefix = opts?.prefix ?? "ca-sess-";
        const out = await cliRun(cfg.listArgs(prefix));
        const names = cfg.parseList(out, prefix);
        return names.map((n) => ({ name: n }));
      } catch {
        return [];
      }
    },

    async exec(containerName, argv, opts) {
      return execOneShot(containerName, argv, opts?.stdin, opts?.timeoutMs);
    },

    startExec(containerName, opts) {
      return Promise.resolve(execStreaming(containerName, opts));
    },
  };

  return provider;
}
