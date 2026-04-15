/**
 * Docker container provider.
 *
 * Runs CLI backends inside local Docker containers instead of sprites.dev.
 * Uses `child_process.spawn("docker", [...])` to interact with the Docker
 * daemon via CLI. Requires Docker to be installed and accessible on the host.
 *
 * Container lifecycle:
 *   create -> docker create --name {name} node:22 sleep infinity + docker start
 *   exec   -> docker exec -i {name} with stdin piped + stdout captured
 *   delete -> docker rm -f {name}
 */
import { createCliProvider } from "./cli-provider";

const DEFAULT_IMAGE = process.env.DOCKER_IMAGE ?? "node:22";

export const dockerProvider = createCliProvider({
  name: "docker",
  binary: "docker",

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

  checkCmd: ["version", "--format", "{{.Server.Version}}"],
  checkFailMsg: (msg) =>
    msg.includes("ENOENT")
      ? "Docker not installed. Run: brew install --cask docker"
      : "Docker not running — launch Docker Desktop",
});
