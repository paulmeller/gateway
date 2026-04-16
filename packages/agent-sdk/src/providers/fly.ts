/**
 * Fly.io Machines provider using REST API.
 *
 * Uses the Fly Machines API (docs.machines.dev) to create and manage
 * containers. No SDK required — communicates via plain HTTP fetch.
 *
 * Container lifecycle:
 *   create → POST /v1/apps/{app}/machines
 *   exec   → POST /v1/apps/{app}/machines/{id}/exec
 *   delete → DELETE /v1/apps/{app}/machines/{id}?force=true
 *
 * Exec is always buffered (no streaming endpoint exists). The API returns
 * a JSON envelope with stdout/stderr/exit_code after the command completes.
 *
 * Fly Machines are identified by machine IDs (not names), so we maintain
 * a name→id map to conform to the ContainerProvider interface.
 *
 * Env vars: FLY_API_TOKEN, FLY_APP_NAME, FLY_IMAGE (default: "node:22")
 */
import type { ContainerProvider, ExecOptions, ExecSession, ProviderSecrets } from "./types";
import { shellEscape } from "./shared";
import { readEnvOrSetting } from "../config";

const BASE_URL = "https://api.machines.dev";

function getToken(secrets?: ProviderSecrets): string {
  const token = secrets?.FLY_API_TOKEN ?? readEnvOrSetting("FLY_API_TOKEN");
  if (!token) throw new Error("FLY_API_TOKEN required — add to vault, .env, or gateway settings");
  return token;
}

function getAppName(secrets?: ProviderSecrets): string {
  const app = secrets?.FLY_APP_NAME ?? readEnvOrSetting("FLY_APP_NAME");
  if (!app) throw new Error("FLY_APP_NAME required — add to vault, .env, or gateway settings");
  return app;
}

function headers(secrets?: ProviderSecrets): Record<string, string> {
  return {
    Authorization: `Bearer ${getToken(secrets)}`,
    "Content-Type": "application/json",
  };
}

// HMR-safe name→machineId map
type GlobalWithFly = typeof globalThis & { __caFlyMachines?: Map<string, string> };
const g = globalThis as GlobalWithFly;
if (!g.__caFlyMachines) g.__caFlyMachines = new Map();
const machines = g.__caFlyMachines;

function getImage(secrets?: ProviderSecrets): string {
  return secrets?.FLY_IMAGE ?? process.env.FLY_IMAGE ?? "node:22";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the exec request body per the Machines API spec. */
function buildExecBody(
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number },
): Record<string, unknown> {
  const cmd = argv.map((a) => shellEscape(a)).join(" ");
  // The API documents a `stdin` field but it doesn't actually pipe data
  // to the command. Encode via base64 to avoid leaking secrets in shell args.
  let fullCmd: string;
  if (opts?.stdin) {
    const b64 = Buffer.from(opts.stdin).toString("base64");
    fullCmd = `echo '${b64}' | base64 -d | ${cmd}`;
  } else {
    fullCmd = cmd;
  }
  return {
    // `command` (string[]) is the current field; `cmd` (string) is deprecated.
    command: ["bash", "-c", fullCmd],
    timeout: opts?.timeoutMs ? Math.ceil(opts.timeoutMs / 1000) : 60,
  };
}

/** Refresh the in-memory name→machineId map from the Fly API. */
async function refreshMachineMap(
  prefix?: string,
  secrets?: ProviderSecrets,
): Promise<Array<{ name: string }>> {
  const app = getAppName(secrets);
  try {
    const res = await fetch(`${BASE_URL}/v1/apps/${app}/machines`, {
      headers: headers(secrets),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ id: string; name?: string }>;
    const pfx = prefix ?? "ca-sess-";
    for (const m of data) {
      if (m.name) machines.set(m.name, m.id);
    }
    return data
      .filter((m) => m.name?.startsWith(pfx))
      .map((m) => ({ name: m.name! }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const flyProvider: ContainerProvider = {
  name: "fly",
  stripControlChars: false,

  async checkAvailability(secrets?: ProviderSecrets) {
    if (!(secrets?.FLY_API_TOKEN ?? readEnvOrSetting("FLY_API_TOKEN"))) {
      return { available: false, message: "FLY_API_TOKEN required — add to vault, .env, or gateway settings" };
    }
    if (!(secrets?.FLY_APP_NAME ?? readEnvOrSetting("FLY_APP_NAME"))) {
      return { available: false, message: "FLY_APP_NAME required — add to vault, .env, or gateway settings" };
    }
    return { available: true };
  },

  async create({ name, secrets }) {
    const app = getAppName(secrets);
    const res = await fetch(`${BASE_URL}/v1/apps/${app}/machines`, {
      method: "POST",
      headers: headers(secrets),
      body: JSON.stringify({
        name,
        config: {
          image: getImage(secrets),
          auto_destroy: true,
          guest: {
            cpu_kind: "shared",
            cpus: 2,
            memory_mb: 1024,
          },
          init: {
            cmd: ["sleep", "infinity"],
          },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Fly create failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { id: string };
    machines.set(name, data.id);

    // Wait for the machine to start
    const machineId = data.id;
    const startRes = await fetch(
      `${BASE_URL}/v1/apps/${app}/machines/${machineId}/wait?state=started&timeout=60`,
      { headers: headers(secrets) },
    );
    if (!startRes.ok) {
      const body = await startRes.text().catch(() => "");
      console.warn(`Fly machine wait-for-start warning (${startRes.status}): ${body}`);
    }
  },

  async delete(name, secrets?) {
    const machineId = machines.get(name);
    if (!machineId) return;
    const app = getAppName(secrets);
    try {
      // Stop first, then destroy
      await fetch(`${BASE_URL}/v1/apps/${app}/machines/${machineId}/stop`, {
        method: "POST",
        headers: headers(secrets),
      }).catch(() => {});

      const res = await fetch(
        `${BASE_URL}/v1/apps/${app}/machines/${machineId}?force=true`,
        {
          method: "DELETE",
          headers: headers(secrets),
        },
      );
      if (!res.ok && res.status !== 404) {
        const body = await res.text().catch(() => "");
        console.warn(`Fly delete failed (${res.status}): ${body}`);
      }
    } catch {
      // Best-effort
    }
    machines.delete(name);
  },

  async list(opts) {
    return refreshMachineMap(opts?.prefix);
  },

  async exec(name, argv, opts) {
    let machineId = machines.get(name);
    const secrets = opts?.secrets;
    if (!machineId) {
      await refreshMachineMap("ca-sess-", secrets);
      machineId = machines.get(name);
      if (!machineId) throw new Error(`Fly machine not found for name: ${name}`);
    }
    const app = getAppName(secrets);

    const execBody = buildExecBody(argv, opts);
    const timeoutSec = (execBody.timeout as number) ?? 60;

    const res = await fetch(
      `${BASE_URL}/v1/apps/${app}/machines/${machineId}/exec`,
      {
        method: "POST",
        headers: headers(secrets),
        body: JSON.stringify(execBody),
        signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Fly exec failed (${res.status}): ${text}`);
    }

    const result = (await res.json()) as {
      stdout?: string;
      stderr?: string;
      exit_code?: number;
    };
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exit_code: result.exit_code ?? 0,
    };
  },

  async startExec(name, opts) {
    let machineId = machines.get(name);
    const secrets = opts.secrets;
    if (!machineId) {
      await refreshMachineMap("ca-sess-", secrets);
      machineId = machines.get(name);
      if (!machineId) throw new Error(`Fly machine not found for name: ${name}`);
    }
    const app = getAppName(secrets);

    const execBody = buildExecBody(opts.argv, {
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs ?? 300_000,
    });

    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) {
        controller.abort();
      } else {
        opts.signal.addEventListener("abort", () => controller.abort());
      }
    }
    const timeoutSec = (execBody.timeout as number) ?? 300;
    const fetchTimer = setTimeout(() => controller.abort(), (timeoutSec + 10) * 1000);

    let res: Response;
    try {
      res = await fetch(
        `${BASE_URL}/v1/apps/${app}/machines/${machineId}/exec`,
        {
          method: "POST",
          headers: headers(secrets),
          body: JSON.stringify(execBody),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(fetchTimer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Fly exec failed (${res.status}): ${text}`);
    }

    // Fly exec is always buffered — returns JSON with stdout/stderr/exit_code.
    // Extract stdout and wrap in a ReadableStream for the provider interface.
    const result = (await res.json()) as {
      stdout?: string;
      stderr?: string;
      exit_code?: number;
    };

    const encoder = new TextEncoder();
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        if (result.stdout) c.enqueue(encoder.encode(result.stdout));
        c.close();
      },
    });

    return {
      stdout,
      exit: Promise.resolve({ code: result.exit_code ?? 0 }),
      async kill() {
        controller.abort();
      },
    };
  },
};
