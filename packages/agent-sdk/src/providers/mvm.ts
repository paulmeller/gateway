/**
 * MVM (Micro Virtual Machine) provider.
 *
 * Uses the `mvm` CLI to manage Firecracker microVMs on macOS.
 * Each VM runs Alpine Linux 3.21 with Node.js, Python, Claude Code, etc.
 *
 * VM lifecycle:
 *   create -> mvm start <name> --net-policy deny
 *   exec   -> mvm exec <name> -- <command>
 *   delete -> mvm delete <name> --force
 *   list   -> mvm list --json
 *
 * Prerequisites:
 *   npm install -g @agentstep/mvm
 *   mvm init   # creates Lima VM, builds rootfs, warms pool (~45s)
 *
 * Benchmarks:
 *   start (warm pool): 0.5s
 *   exec echo: 0.1s
 *   exec node --version: 1.4s
 *   delete: 0.3s
 *
 * Ref: https://github.com/agentstep/mvm
 */
import { createCliProvider } from "./cli-provider";

export const mvmProvider = createCliProvider({
  name: "mvm",
  binary: "mvm",

  createSteps: (name) => [
    ["start", name, "--net-policy", "deny"],
  ],

  deleteArgs: (name) => ["delete", name, "--force"],

  execArgs: (name, argv) => ["exec", name, "--", ...argv],

  listArgs: () => ["list", "--json"],

  parseList: (stdout, prefix) => {
    try {
      const vms = JSON.parse(stdout) as Array<{ name: string }>;
      return vms.filter((vm) => !prefix || vm.name.startsWith(prefix)).map((vm) => vm.name);
    } catch {
      return [];
    }
  },

  checkAvailability: async () => {
    if (process.platform !== "darwin") {
      return { available: false, message: "mvm requires macOS" };
    }

    const { spawn } = await import("node:child_process");

    // 1. Check mvm CLI exists
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("mvm", ["version"], { stdio: ["pipe", "pipe", "pipe"] });
        proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        proc.on("error", reject);
      });
    } catch {
      return { available: false, message: "mvm CLI not found. Install with: npm install -g @agentstep/mvm" };
    }

    // 2. Check warm pool has ≥1 VM
    try {
      const out = await new Promise<string>((resolve, reject) => {
        let data = "";
        const proc = spawn("mvm", ["pool", "status"], { stdio: ["pipe", "pipe", "pipe"] });
        proc.stdout.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        proc.on("close", (code) => code === 0 ? resolve(data) : reject(new Error(`exit ${code}`)));
        proc.on("error", reject);
      });

      // Pool status output contains the count of warm VMs
      const match = out.match(/(\d+)/);
      const count = match ? parseInt(match[1], 10) : 0;
      if (count < 1) {
        return { available: false, message: "mvm pool is empty. Run: mvm init" };
      }
    } catch {
      return { available: false, message: "mvm not ready. Run: mvm init" };
    }

    return { available: true };
  },
});
