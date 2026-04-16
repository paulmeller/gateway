/**
 * mvm (AgentStep Machines) provider.
 *
 * Runs CLI backends inside hardware-isolated Firecracker microVMs via mvm.
 * Each session gets its own VM with a separate Linux kernel.
 *
 * mvm is a local service the user sets up independently. The gateway never
 * installs, configures, or manages mvm itself.
 *
 * Available commands (the full set we use):
 *   mvm version                         -- check CLI exists
 *   mvm pool status                     -- check warm pool (gate on >= 1)
 *   mvm start <name> --net-policy deny  -- create VM (0.3s from warm pool)
 *   mvm exec <name> -- <command>        -- run command in VM
 *   mvm delete <name> --force           -- destroy VM
 *   mvm list --json                     -- list VMs as JSON
 */
import { spawn } from "node:child_process";
import { createCliProvider } from "./cli-provider";

const NET_POLICY = process.env.MVM_NET_POLICY ?? "deny";

export const mvmProvider = createCliProvider({
  name: "apple-firecracker",
  binary: "mvm",

  createSteps: (name) => [
    ["start", name, "--net-policy", NET_POLICY],
  ],

  postCreate: (name, runExec) => {
    // Build V8 bytecode cache in background -- speeds up turn 1 from ~55s to ~8s startup
    runExec(
      [
        "sh",
        "-c",
        "export NODE_COMPILE_CACHE=/tmp/v8-cache; mkdir -p /tmp/v8-cache; claude --version >/dev/null 2>&1 || true",
      ],
      undefined,
      120_000,
    ).catch(() => {});
  },

  deleteArgs: (name) => ["delete", name, "--force"],

  execArgs: (name, argv) => ["exec", name, "--", ...argv],

  listArgs: () => ["list", "--json"],

  parseList: (stdout, prefix) => {
    try {
      const vms = JSON.parse(stdout) as { name: string }[];
      return vms
        .filter((v) => v.name.startsWith(prefix))
        .map((v) => v.name);
    } catch {
      return [];
    }
  },

  checkAvailability: async () => {
    // 1. CLI installed?
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("mvm", ["version"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        proc.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
        );
        proc.on("error", reject);
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error("timeout"));
        }, 5000);
        proc.on("close", () => clearTimeout(t));
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT")) {
        return {
          available: false,
          message:
            "mvm is not installed. Run: npm install -g @agentstep/mvm && mvm init",
        };
      }
      return { available: false, message: `mvm CLI not available: ${msg}` };
    }

    // 2. Warm pool ready?
    try {
      const poolOut = await new Promise<string>((resolve, reject) => {
        const proc = spawn("mvm", ["pool", "status"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        proc.stdout?.on("data", (buf: Buffer) => {
          out += buf.toString();
        });
        proc.on("close", (code) =>
          code === 0
            ? resolve(out)
            : reject(new Error(`exit ${code}`)),
        );
        proc.on("error", reject);
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error("timeout"));
        }, 5000);
        proc.on("close", () => clearTimeout(t));
      });
      if (poolOut.includes("0/")) {
        return {
          available: false,
          message:
            "mvm not ready. Run: mvm init && mvm serve install && mvm pool warm",
        };
      }
    } catch {
      return {
        available: false,
        message:
          "mvm not ready. Run: mvm init && mvm serve install && mvm pool warm",
      };
    }

    return { available: true };
  },
});
