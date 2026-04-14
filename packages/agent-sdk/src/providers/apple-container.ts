/**
 * Apple Containers provider (macOS 26+).
 *
 * Runs CLI backends inside Apple's native container runtime instead of
 * Docker or sprites.dev. Requires macOS 26 (Tahoe) with Apple Silicon.
 *
 * Container lifecycle:
 *   create -> container create --name {name} node:22 sleep infinity + container start
 *   exec   -> container exec -i {name} with stdin piped + stdout captured
 *   delete -> container rm -f {name}
 *
 * Differences from Docker:
 *   - CLI binary is `container` not `docker`
 *   - List command is `container ls` not `docker ps`
 *   - Uses Apple's Virtualization.framework (VM-per-container, not shared kernel)
 *
 * Ref: https://github.com/apple/container
 */
import { createCliProvider } from "./cli-provider";

const DEFAULT_IMAGE = process.env.APPLE_CONTAINER_IMAGE ?? "node:22";

export const appleProvider = createCliProvider({
  name: "apple-container",
  binary: "container",

  createSteps: (name) => [
    ["create", "--name", name, DEFAULT_IMAGE, "sleep", "infinity"],
    ["start", name],
  ],

  deleteArgs: (name) => ["rm", "-f", name],

  execArgs: (name, argv) => ["exec", "-i", name, ...argv],

  // Apple uses `container ls` not `docker ps`
  listArgs: (prefix) => [
    "ls", "-a",
    "--filter", `name=${prefix}`,
    "--format", "{{.Names}}",
  ],

  parseList: (stdout) =>
    stdout.trim().split("\n").filter(Boolean),

  checkAvailability: async () => {
    if (process.platform !== "darwin") {
      return { available: false, message: "Apple Containers requires macOS" };
    }
    // The rest is handled by the default checkCmd path, but since we need
    // the platform guard we implement the full check inline.
    try {
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("container", ["--version"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        proc.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
        );
        proc.on("error", reject);
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error("timeout"));
        }, 3000);
        proc.on("close", () => clearTimeout(t));
      });
      return { available: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT")) {
        return {
          available: false,
          message: "Apple Containers not installed. Run: brew install container (requires macOS 26+)",
        };
      }
      return {
        available: false,
        message: `Apple Containers not accessible: ${msg}`,
      };
    }
  },
});
