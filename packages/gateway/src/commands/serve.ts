import { Command } from "commander";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY_FILE = path.join(process.cwd(), "data", ".api-key");

function getOrCreateKey(): string {
  // 1. Env var wins
  if (process.env.SEED_API_KEY) return process.env.SEED_API_KEY;

  // 2. Persisted key file
  try {
    const saved = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (saved) { process.env.SEED_API_KEY = saved; return saved; }
  } catch {}

  // 3. Generate new, persist it
  const key = `ck_${crypto.randomBytes(16).toString("base64url")}`;
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  } catch {}
  process.env.SEED_API_KEY = key;
  return key;
}

/** Show only the first 6 and last 4 characters of a key. */
function maskKey(key: string): string {
  if (key.length <= 10) return "••••••••";
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

export function registerServeCommand(parent: Command): void {
  parent.command("serve")
    .description("Start the Managed Agents API server")
    .option("--port <port>", "Port to listen on", "4000")
    .option(
      "--host <addr>",
      "Bind address. Default is 127.0.0.1 (loopback). Pass 0.0.0.0 to expose to the network — requires you to understand the security implications.",
      "127.0.0.1",
    )
    .action(async (opts) => {
      await import("dotenv/config");

      const key = getOrCreateKey();

      const { serve } = await import("@hono/node-server");
      const { default: app } = await import("@agentstep/gateway-hono");
      const port = Number(opts.port);
      const hostname = String(opts.host);
      const isPublic = hostname === "0.0.0.0" || hostname === "::";

      let version = "dev";
      try {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        // Try multiple paths: bundled (dist/gateway.js → ../package.json) and source (src/commands/ → ../../package.json)
        const candidates = [
          path.join(__dirname, "../package.json"),
          path.join(__dirname, "../../package.json"),
          path.join(process.cwd(), "package.json"),
        ];
        for (const p of candidates) {
          try {
            const pkg = JSON.parse(fs.readFileSync(p, "utf-8"));
            if (pkg.version && pkg.name?.includes("gateway")) { version = pkg.version; break; }
          } catch {}
        }
      } catch {}
      process.env.GATEWAY_VERSION = version;

      const display = hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;

      console.log("");
      console.log(`  AgentStep Gateway v${version}`);
      console.log("");
      console.log(`  → UI:      http://${display}:${port}`);
      console.log(`  → API:     http://${display}:${port}/v1`);
      console.log(`  → Docs:    http://${display}:${port}/v1/docs`);
      // Mask the key by default. The unmasked value is written to .env /
      // data/.api-key — that's the only place it should appear.
      console.log(`  → Key:     ${maskKey(key)}   (unmasked key in data/.api-key)`);
      if (isPublic) {
        console.log("");
        console.log("  ⚠  Bound to a public address — anyone on this network can reach the API.");
        console.log("     The embedded UI injects the API key into HTML at /. Use only on trusted");
        console.log("     networks, behind a reverse proxy with auth, or bind to 127.0.0.1.");
      }
      console.log("");
      console.log(`  → Website: https://www.agentstep.com`);
      console.log(`  → Docs:    https://www.agentstep.com/docs`);
      console.log("");

      serve({ fetch: app.fetch, port, hostname });
    });
}
