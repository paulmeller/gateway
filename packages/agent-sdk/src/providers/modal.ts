/**
 * Modal sandbox provider using the official JS SDK.
 *
 * Uses the `modal` npm package (v0.7+) to create and manage sandboxes.
 * The SDK communicates via gRPC (not REST). Auth is via MODAL_TOKEN_ID +
 * MODAL_TOKEN_SECRET env vars or ~/.modal.toml config file.
 *
 * Sandbox lifecycle:
 *   create → modal.sandboxes.create(app, image, { command: ["sleep", "infinity"] })
 *   exec   → sandbox.exec(["bash", "-c", cmd])
 *   delete → sandbox.terminate()
 *
 * Env vars: MODAL_TOKEN_ID, MODAL_TOKEN_SECRET (or ~/.modal.toml)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ContainerProvider, ProviderSecrets } from "./types";
import { shellEscape } from "./shared";
import { readEnvOrSetting } from "../config";

// Lazy-loaded SDK types matching modal@0.7.x
type ModalSandbox = {
  sandboxId: string;
  exec(
    argv: string[],
    opts?: {
      stdout?: "pipe" | "ignore";
      stderr?: "pipe" | "ignore";
      workdir?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      pty?: boolean;
    },
  ): Promise<{
    stdout: { readText(): Promise<string> };
    stderr: { readText(): Promise<string> };
    stdin: { writeText(data: string): Promise<void>; close(): Promise<void> };
    wait(): Promise<number>;
  }>;
  terminate(opts?: { wait?: boolean }): Promise<number | void>;
};

type ModalImage = {
  dockerfileCommands(commands: string[]): ModalImage;
};

type ModalApp = unknown;

type ModalClient = {
  apps: {
    fromName(name: string, opts?: { createIfMissing?: boolean }): Promise<ModalApp>;
  };
  images: {
    fromRegistry(image: string): ModalImage;
  };
  sandboxes: {
    create(
      app: ModalApp,
      image: ModalImage,
      opts?: {
        command?: string[];
        cpu?: number;
        memoryMiB?: number;
        timeoutMs?: number;
        env?: Record<string, string>;
        blockNetwork?: boolean;
        name?: string;
      },
    ): Promise<ModalSandbox>;
    fromId(sandboxId: string): Promise<ModalSandbox>;
    list(opts?: { appId?: string; tags?: Record<string, string> }): AsyncIterable<ModalSandbox>;
  };
};

let clientInstance: ModalClient | null = null;

async function getClient(secrets?: Record<string, string>): Promise<ModalClient> {
  // Resolve auth: vault secrets first, then env, then gateway settings.
  // If any source provides creds we create a fresh client with them set
  // on process.env for the modal SDK's lifetime; we restore the
  // previous values in finally.
  const resolvedId = secrets?.MODAL_TOKEN_ID ?? readEnvOrSetting("MODAL_TOKEN_ID");
  const resolvedSecret = secrets?.MODAL_TOKEN_SECRET ?? readEnvOrSetting("MODAL_TOKEN_SECRET");
  // Only take the "fresh client" path when we're overriding from a
  // source other than pure process.env — otherwise the cached client
  // path below handles it.
  const needsOverride = Boolean(
    secrets?.MODAL_TOKEN_ID || secrets?.MODAL_TOKEN_SECRET ||
    (resolvedId && resolvedId !== process.env.MODAL_TOKEN_ID) ||
    (resolvedSecret && resolvedSecret !== process.env.MODAL_TOKEN_SECRET),
  );
  if (needsOverride) {
    const origId = process.env.MODAL_TOKEN_ID;
    const origSecret = process.env.MODAL_TOKEN_SECRET;
    try {
      if (resolvedId) process.env.MODAL_TOKEN_ID = resolvedId;
      if (resolvedSecret) process.env.MODAL_TOKEN_SECRET = resolvedSecret;
      const mod = await import("modal");
      const ClientClass = (mod as any).ModalClient ?? (mod as any).default?.ModalClient;
      if (!ClientClass) throw new Error("ModalClient not found in modal exports");
      return new ClientClass() as ModalClient;
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("Cannot find module") ||
          err.message.includes("MODULE_NOT_FOUND") ||
          err.message.includes("ERR_MODULE_NOT_FOUND"))
      ) {
        throw new Error("Modal requires the modal package. Install with: npm install modal");
      }
      throw err;
    } finally {
      if (origId !== undefined) process.env.MODAL_TOKEN_ID = origId;
      else delete process.env.MODAL_TOKEN_ID;
      if (origSecret !== undefined) process.env.MODAL_TOKEN_SECRET = origSecret;
      else delete process.env.MODAL_TOKEN_SECRET;
    }
  }

  // Default: cached client using env vars / config file
  if (clientInstance) return clientInstance;
  try {
    const mod = await import("modal");
    const ClientClass = (mod as any).ModalClient ?? (mod as any).default?.ModalClient;
    if (!ClientClass) throw new Error("ModalClient not found in modal exports");
    clientInstance = new ClientClass() as ModalClient;
    return clientInstance;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("Cannot find module") ||
        err.message.includes("MODULE_NOT_FOUND") ||
        err.message.includes("ERR_MODULE_NOT_FOUND"))
    ) {
      throw new Error("Modal requires the modal package. Install with: npm install modal");
    }
    throw err;
  }
}

// HMR-safe sandbox instance map
type GlobalWithModal = typeof globalThis & {
  __caModalSandboxes?: Map<string, ModalSandbox>;
  __caModalApp?: ModalApp;
};
const g = globalThis as GlobalWithModal;
if (!g.__caModalSandboxes) g.__caModalSandboxes = new Map();
const sandboxes = g.__caModalSandboxes;

const APP_NAME = "agentstep-gateway";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const modalProvider: ContainerProvider = {
  name: "modal",
  stripControlChars: false,

  async checkAvailability(secrets?: ProviderSecrets) {
    try {
      await getClient();
    } catch {
      return { available: false, message: "Modal requires the modal npm package. Install with: npm install modal" };
    }
    // Auth is read from env vars or ~/.modal.toml by the SDK automatically
    const hasTokenId = secrets?.MODAL_TOKEN_ID ?? readEnvOrSetting("MODAL_TOKEN_ID");
    const hasTokenSecret = secrets?.MODAL_TOKEN_SECRET ?? readEnvOrSetting("MODAL_TOKEN_SECRET");
    if (!hasTokenId && !hasTokenSecret) {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      const tomlPath = process.env.MODAL_CONFIG_PATH ?? join(home, ".modal.toml");
      if (!existsSync(tomlPath)) {
        return { available: false, message: "MODAL_TOKEN_ID + MODAL_TOKEN_SECRET required — add to vault or .env (or run: modal token set)" };
      }
    }
    return { available: true };
  },

  async create({ name, secrets }) {
    const client = await getClient(secrets);

    if (!g.__caModalApp) {
      g.__caModalApp = await client.apps.fromName(APP_NAME, { createIfMissing: true });
    }

    const image = client.images.fromRegistry("node:22");
    const sandbox = await client.sandboxes.create(g.__caModalApp, image, {
      command: ["sleep", "infinity"],
      cpu: 2,
      memoryMiB: 2048,
      timeoutMs: 3600_000, // 1 hour max lifetime
      name,
    });
    sandboxes.set(name, sandbox);
  },

  async delete(name) {
    const sandbox = sandboxes.get(name);
    if (!sandbox) return;
    try {
      await sandbox.terminate();
    } catch {
      // Best-effort
    }
    sandboxes.delete(name);
  },

  async list(opts) {
    const prefix = opts?.prefix ?? "ca-sess-";
    // In-memory map — Modal's list() returns sandboxes but we can't
    // easily reconnect without the app context after a restart.
    return Array.from(sandboxes.keys())
      .filter((n) => n.startsWith(prefix))
      .map((name) => ({ name }));
  },

  async exec(name, argv, opts) {
    const sandbox = sandboxes.get(name);
    if (!sandbox) throw new Error(`Modal sandbox not found: ${name}`);

    const cmd = argv.map((a) => shellEscape(a)).join(" ");

    const proc = await sandbox.exec(["bash", "-c", cmd], {
      timeoutMs: opts?.timeoutMs,
    });
    // Pipe stdin via the SDK's native stdin support
    if (opts?.stdin) {
      await proc.stdin.writeText(opts.stdin);
      await proc.stdin.close();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.readText(),
      proc.stderr.readText(),
      proc.wait(),
    ]);
    return { stdout, stderr, exit_code: exitCode };
  },

  async startExec(name, opts) {
    const sandbox = sandboxes.get(name);
    if (!sandbox) throw new Error(`Modal sandbox not found: ${name}`);

    const cmd = opts.argv.map((a) => shellEscape(a)).join(" ");

    const proc = await sandbox.exec(["bash", "-c", cmd], {
      timeoutMs: opts.timeoutMs,
    });
    if (opts.stdin) {
      await proc.stdin.writeText(opts.stdin);
      await proc.stdin.close();
    }

    // Stream stdout as a ReadableStream
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array>;

    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });

    // Read stdout in background and push to stream
    const exit = proc.stdout.readText().then(async (text) => {
      try {
        if (text) streamController.enqueue(encoder.encode(text));
        streamController.close();
      } catch {
        // Already closed
      }
      return { code: await proc.wait() };
    }).catch(async (err) => {
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
        // Modal doesn't support killing individual exec processes
      },
    };
  },
};
