/**
 * Podman container provider.
 *
 * Nearly identical to Docker — uses `podman` CLI instead of `docker`.
 * Podman is a drop-in replacement for Docker with the same CLI surface.
 *
 * Container lifecycle:
 *   create -> podman create --name {name} node:22 sleep infinity + podman start
 *   exec   -> podman exec -i {name} with stdin piped + stdout captured
 *   delete -> podman rm -f {name}
 */
import { createCliProvider } from "./cli-provider";

const DEFAULT_IMAGE = process.env.PODMAN_IMAGE ?? "node:22";

export const podmanProvider = createCliProvider({
  name: "podman",
  binary: "podman",

  createSteps: (name) => [
    ["create", "--name", name, DEFAULT_IMAGE, "sleep", "infinity"],
    ["start", name],
  ],

  deleteArgs: (name) => ["rm", "-f", name],

  execArgs: (name, argv) => ["exec", "-i", name, ...argv],

  listArgs: (prefix) => [
    "ps", "-a",
    "--filter", `name=${prefix}`,
    "--format", "{{.Names}}",
  ],

  parseList: (stdout) =>
    stdout.trim().split("\n").filter(Boolean),

  checkCmd: ["version", "--format", "{{.Version}}"],
  checkFailMsg: (msg) =>
    msg.includes("ENOENT")
      ? "Podman CLI is not installed. Install it from https://podman.io/docs/installation"
      : `Podman is not running or not accessible: ${msg}`,
});
