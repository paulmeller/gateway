import { Command } from "commander";
import { createInterface } from "node:readline";
import { initBackend } from "../index.js";
import { waitForEnvironment } from "./environments.js";
import { runChatLoop } from "./chat-loop.js";

export function registerQuickstartCommand(parent: Command): void {
  parent.command("quickstart")
    .description("Create agent + environment + session and start chatting")
    .option("--engine <engine>", "Agent harness: claude, opencode, codex, gemini, factory", "claude")
    .option("--model <model>", "Model (defaults per engine)")
    .option("--provider <provider>", "Provider: sprites, docker, apple-container, podman, e2b, vercel, daytona, fly, modal, mvm", "sprites")
    .action(async (opts) => {
      const b = await initBackend();
      const verbose = parent.opts().verbose ?? false;
      const model = opts.model || defaultModel(opts.engine);

      // Step 1: Agent — reuse existing or create new
      console.log("\n  1  Agent  →  2  Environment  →  3  Secrets  →  4  Chat\n");
      const agentName = `quickstart-${opts.engine}`;
      let agent: any;
      try {
        agent = await b.agents.create({ name: agentName, model, backend: opts.engine });
        console.log(`Creating agent (backend: ${opts.engine}, model: ${model})...`);
      } catch (err: any) {
        if (err?.message?.includes("already exists")) {
          const list = await b.agents.list({ limit: 50 });
          agent = list.data.find((a: any) => a.name === agentName);
          if (!agent) throw err;
          console.log(`Reusing existing agent "${agentName}"...`);
        } else {
          throw err;
        }
      }
      console.log(`  Agent: ${agent.id}\n`);

      // Step 2: Environment — reuse existing or create new
      console.log("  1  Agent  →  2  Environment  →  3  Secrets  →  4  Chat\n");
      await ensureProviderToken(opts.provider);
      const envName = `quickstart-${opts.provider}`;
      let env: any;
      try {
        console.log(`Creating environment (provider: ${opts.provider})...`);
        env = await b.environments.create({
          name: envName,
          config: { type: "cloud", provider: opts.provider },
        });
      } catch (err: any) {
        if (err?.message?.includes("already exists")) {
          const list = await b.environments.list({ limit: 50 });
          env = list.data.find((e: any) => e.name === envName);
          if (!env) throw err;
          console.log(`Reusing existing environment "${envName}"...`);
        } else {
          throw err;
        }
      }
      console.log(`  Environment: ${env.id}\n`);

      // Step 3: Secrets — save to vault (consistent with web UI)
      console.log("  1  Agent  →  2  Environment  →  3  Secrets  →  4  Chat\n");
      const vaultId = await ensureEngineSecrets(b, opts.engine, agent.id);

      // Wait for environment to be ready
      await waitForEnvironment(b, env.id, 120_000, 2_000);

      // Step 4: Chat — attach vault to session if we created one
      console.log("  1  Agent  →  2  Environment  →  3  Secrets  →  4  Chat\n");
      console.log("Creating session...");
      const sessionOpts: Record<string, unknown> = { agent: agent.id, environment_id: env.id };
      if (vaultId) sessionOpts.vault_ids = [vaultId];
      const session = await b.sessions.create(sessionOpts);
      console.log(`  Session: ${session.id}\n`);

      console.log("Type a message and press Enter. Ctrl+C to interrupt, Ctrl+D to exit.");
      console.log("─".repeat(60));
      await runChatLoop(b, session.id, { verbose, initialStatus: "idle" });
    });
}

const BACKEND_KEYS: Record<string, { envVars: string[]; label: string }> = {
  claude: { envVars: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], label: "ANTHROPIC_API_KEY" },
  codex: { envVars: ["OPENAI_API_KEY"], label: "OPENAI_API_KEY" },
  opencode: { envVars: ["OPENAI_API_KEY"], label: "OPENAI_API_KEY" },
  gemini: { envVars: ["GEMINI_API_KEY"], label: "GEMINI_API_KEY" },
  factory: { envVars: ["FACTORY_API_KEY"], label: "FACTORY_API_KEY" },
};

/** Returns vault ID if a vault was created, null if using server keys. */
async function ensureEngineSecrets(b: any, backend: string, agentId: string): Promise<string | null> {
  const req = BACKEND_KEYS[backend] ?? BACKEND_KEYS.claude;

  // Check if key exists server-side (env var or settings DB)
  let hasServerKey = req.envVars.some((k) => process.env[k]);
  if (!hasServerKey) {
    try {
      const { getConfig } = await import("@agentstep/agent-sdk/config");
      const cfg = getConfig() as Record<string, unknown>;
      const configKeyMap: Record<string, string> = {
        ANTHROPIC_API_KEY: "anthropicApiKey",
        CLAUDE_CODE_OAUTH_TOKEN: "claudeToken",
        OPENAI_API_KEY: "openAiApiKey",
        GEMINI_API_KEY: "geminiApiKey",
        FACTORY_API_KEY: "factoryApiKey",
      };
      hasServerKey = req.envVars.some((k) => !!cfg[configKeyMap[k]]);
    } catch {}
  }

  if (hasServerKey) {
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${req.label} is configured. Override with your own key? (y/N) `, resolve);
      });
      rl.close();

      if (answer.trim().toLowerCase().startsWith("y")) {
        return promptAndSaveToVault(b, req, agentId);
      }
    }
    console.log("Using server-configured key.\n");
    return null;
  }

  // No key anywhere — must enter one
  if (!process.stdin.isTTY) {
    console.error(`Error: ${backend} backend requires ${req.label} to be set.\n\n  export ${req.label}=<your-key>\n`);
    process.exit(1);
  }

  console.log(`No API key found for ${backend} backend.\n`);
  return promptAndSaveToVault(b, req, agentId);
}

async function promptAndSaveToVault(b: any, req: typeof BACKEND_KEYS[string], agentId: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const key = await new Promise<string>((resolve) => {
    rl.question(`Paste your ${req.label}: `, resolve);
  });
  rl.close();

  const trimmed = key.trim();
  if (!trimmed) {
    console.error("No key provided.");
    process.exit(1);
  }

  // Detect oauth token
  let envKey = req.envVars[0];
  if (envKey === "ANTHROPIC_API_KEY" && trimmed.startsWith("sk-ant-oat")) {
    envKey = "CLAUDE_CODE_OAUTH_TOKEN";
  }

  // Save to vault (consistent with web UI flow)
  const vault = await b.vaults.create({ agent_id: agentId, name: "secrets" });
  await b.vaults.entries.set(vault.id, envKey, trimmed);
  console.log("Saved to vault.\n");
  return vault.id;
}

const PROVIDER_TOKENS: Record<string, { envVar: string; settingKey: string; label: string }> = {
  sprites: { envVar: "SPRITE_TOKEN", settingKey: "sprite_token", label: "Sprites.dev Token" },
  e2b: { envVar: "E2B_API_KEY", settingKey: "e2b_api_key", label: "E2B API Key" },
  vercel: { envVar: "VERCEL_TOKEN", settingKey: "vercel_token", label: "Vercel Token" },
  daytona: { envVar: "DAYTONA_API_KEY", settingKey: "daytona_api_key", label: "Daytona API Key" },
  fly: { envVar: "FLY_API_TOKEN", settingKey: "fly_api_token", label: "Fly.io API Token" },
  modal: { envVar: "MODAL_TOKEN_ID", settingKey: "modal_token_id", label: "Modal Token ID" },
};

async function ensureProviderToken(provider: string): Promise<void> {
  const tokenInfo = PROVIDER_TOKENS[provider];
  if (!tokenInfo) return; // local providers (docker, apple-container, etc.) don't need tokens

  // Check if token already exists in env or settings
  if (process.env[tokenInfo.envVar]) return;
  try {
    const { getConfig } = await import("@agentstep/agent-sdk/config");
    const cfg = getConfig() as Record<string, unknown>;
    if (cfg[tokenInfo.settingKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())]) return;
  } catch {}

  // Not found — prompt for it
  if (!process.stdin.isTTY) {
    console.error(`Error: ${provider} provider requires ${tokenInfo.envVar}.\n\n  export ${tokenInfo.envVar}=<your-token>\n`);
    process.exit(1);
  }

  console.log(`${provider} provider requires a token.\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const token = await new Promise<string>((resolve) => {
    rl.question(`Paste your ${tokenInfo.label}: `, resolve);
  });
  rl.close();

  const trimmed = token.trim();
  if (!trimmed) {
    console.error("No token provided.");
    process.exit(1);
  }

  // Save to settings DB (same as web UI)
  const { writeSetting } = await import("@agentstep/agent-sdk/config");
  writeSetting(tokenInfo.settingKey, trimmed);
  console.log(`Saved ${tokenInfo.label} to settings.\n`);
}

function defaultModel(backend: string): string {
  switch (backend) {
    case "opencode": return "openai/gpt-4o";
    case "codex": return "gpt-4o";
    default: return "claude-sonnet-4-6";
  }
}
