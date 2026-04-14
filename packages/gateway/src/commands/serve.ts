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

export function registerServeCommand(parent: Command): void {
  parent.command("serve")
    .description("Start the Managed Agents API server")
    .option("--port <port>", "Port to listen on", "4000")
    .action(async (opts) => {
      await import("dotenv/config");

      const key = getOrCreateKey();

      const { serve } = await import("@hono/node-server");
      const { default: app } = await import("@agentstep/gateway-hono");
      const port = Number(opts.port);

      let version = "dev";
      try {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf-8"));
        version = pkg.version;
      } catch {}
      process.env.GATEWAY_VERSION = version;

      console.log("");
      console.log(`  AgentStep Gateway v${version}`);
      console.log("");
      console.log(`  → UI:      http://localhost:${port}`);
      console.log(`  → API:     http://localhost:${port}/v1`);
      console.log(`  → Docs:    http://localhost:${port}/v1/docs`);
      console.log(`  → Key:     ${key}`);
      console.log("");
      console.log(`  → Website: https://www.agentstep.com`);
      console.log(`  → Docs:    https://www.agentstep.com/docs`);
      console.log("");

      serve({ fetch: app.fetch, port });
    });
}
