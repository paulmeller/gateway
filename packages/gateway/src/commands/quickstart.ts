import { Command } from "commander";
import * as p from "@clack/prompts";
import { initBackend } from "../index.js";
import { waitForEnvironment } from "./environments.js";
import { runChatLoop } from "./chat-loop.js";

const LOCAL_PROVIDERS = ["docker", "apple-container", "apple-firecracker", "podman", "mvm"];
const CLOUD_PROVIDERS = ["anthropic", "sprites", "e2b", "vercel", "daytona", "fly", "modal"];

const ENGINES = ["claude", "opencode", "codex", "gemini", "factory", "pi"] as const;
type Engine = typeof ENGINES[number];

const ENGINE_MODELS: Record<Engine, string[]> = {
  claude: ["claude-sonnet-4-6", "claude-opus-4-5", "claude-haiku-3-5"],
  opencode: ["openai/gpt-4o", "openai/gpt-4o-mini", "openai/o3"],
  codex: ["gpt-4o", "gpt-4o-mini", "o3"],
  gemini: ["gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-pro"],
  factory: ["factory-default"],
  pi: ["anthropic/claude-sonnet-4-6", "openai/gpt-4o-mini", "google/gemini-2.5-flash"],
};

export function registerQuickstartCommand(parent: Command): void {
  parent.command("quickstart")
    .description("Create agent + environment + session and start chatting")
    .option("--engine <engine>", "Agent harness: claude, opencode, codex, gemini, factory, pi", "claude")
    .option("--model <model>", "Model (defaults per engine)")
    .option("--provider <provider>", "Provider: sprites, docker, apple-container, podman, e2b, vercel, daytona, fly, modal, mvm", "sprites")
    .action(async (opts) => {
      const b = await initBackend();
      const verbose = parent.opts().verbose ?? false;
      const interactive = process.stdin.isTTY && process.stdout.isTTY;

      if (interactive) {
        await runInteractiveQuickstart(b, opts, verbose);
      } else {
        await runNonInteractiveQuickstart(b, opts, verbose);
      }
    });
}

// ---------------------------------------------------------------------------
// Interactive path (TTY)
// ---------------------------------------------------------------------------

async function runInteractiveQuickstart(b: any, opts: any, verbose: boolean): Promise<void> {
  p.intro("AgentStep Gateway Quickstart");

  // ── Step 1: Agent ──────────────────────────────────────────────────────────
  const agents = await b.agents.list({ limit: 50 });
  const agentChoices = [
    ...agents.data.map((a: any) => ({
      value: a.id as string,
      label: a.name as string,
      hint: `${a.engine ?? a.backend ?? ""} / ${a.model ?? ""}`,
    })),
    { value: "__create__", label: "Create new agent" },
  ];

  const agentChoice = await p.select({
    message: "Choose an agent",
    options: agentChoices,
  });
  if (p.isCancel(agentChoice)) { p.cancel("Cancelled."); process.exit(0); }

  let agent: any;

  if (agentChoice === "__create__") {
    const name = await p.text({
      message: "Agent name",
      defaultValue: "Coder",
      validate: (v) => (v.trim().length === 0 ? "Name is required" : undefined),
    });
    if (p.isCancel(name)) { p.cancel("Cancelled."); process.exit(0); }

    const engine = await p.select<Engine>({
      message: "Engine",
      options: ENGINES.map((e) => ({ value: e, label: e })),
      initialValue: (opts.engine ?? "claude") as Engine,
    });
    if (p.isCancel(engine)) { p.cancel("Cancelled."); process.exit(0); }

    const modelOptions = ENGINE_MODELS[engine as Engine] ?? [defaultModel(engine as string)];
    const model = await p.select<string>({
      message: "Model",
      options: modelOptions.map((m) => ({ value: m, label: m })),
      initialValue: opts.model ?? modelOptions[0],
    });
    if (p.isCancel(model)) { p.cancel("Cancelled."); process.exit(0); }

    const s = p.spinner();
    s.start("Creating agent...");
    try {
      agent = await b.agents.create({ name: (name as string).trim(), model, backend: engine });
      s.stop(`Agent created: ${agent.id}`);
    } catch (err: any) {
      if (err?.message?.includes("already exists")) {
        const list = await b.agents.list({ limit: 50 });
        agent = list.data.find((a: any) => a.name === (name as string).trim());
        if (!agent) { s.stop("Failed to create agent."); throw err; }
        s.stop(`Reusing existing agent "${agent.name}"`);
      } else {
        s.stop("Failed to create agent.");
        throw err;
      }
    }
  } else {
    agent = agents.data.find((a: any) => a.id === agentChoice);
    p.log.info(`Using agent: ${agent.name}`);
  }

  // ── Step 2: Environment ────────────────────────────────────────────────────
  const envs = await b.environments.list({ limit: 50 });
  const readyEnvs = envs.data.filter((e: any) => e.status === "ready" || e.status === "idle");
  const envChoices = [
    ...readyEnvs.map((e: any) => ({
      value: e.id as string,
      label: e.name as string,
      hint: e.provider ?? "",
    })),
    { value: "__create__", label: "Create new environment" },
  ];

  const envChoice = await p.select({
    message: "Choose an environment",
    options: envChoices,
  });
  if (p.isCancel(envChoice)) { p.cancel("Cancelled."); process.exit(0); }

  let env: any;

  if (envChoice === "__create__") {
    const envName = await p.text({
      message: "Environment name",
      defaultValue: "quickstart",
      validate: (v) => (v.trim().length === 0 ? "Name is required" : undefined),
    });
    if (p.isCancel(envName)) { p.cancel("Cancelled."); process.exit(0); }

    const provider = await p.select<string>({
      message: "Choose a provider",
      options: [
        ...LOCAL_PROVIDERS.map((pr) => ({ value: pr, label: pr, hint: "local" })),
        ...CLOUD_PROVIDERS.map((pr) => ({ value: pr, label: pr, hint: "cloud" })),
      ],
      initialValue: opts.provider ?? "sprites",
    });
    if (p.isCancel(provider)) { p.cancel("Cancelled."); process.exit(0); }

    // Ensure provider token before creating env
    await ensureProviderTokenInteractive(provider as string);

    const s = p.spinner();
    s.start("Creating environment...");
    try {
      env = await b.environments.create({
        name: (envName as string).trim(),
        config: { type: "cloud", provider },
      });
      s.stop(`Environment created: ${env.id}`);
    } catch (err: any) {
      if (err?.message?.includes("already exists")) {
        const list = await b.environments.list({ limit: 50 });
        env = list.data.find((e: any) => e.name === (envName as string).trim());
        if (!env) { s.stop("Failed to create environment."); throw err; }
        s.stop(`Reusing existing environment "${env.name}"`);
      } else {
        s.stop("Failed to create environment.");
        throw err;
      }
    }
  } else {
    env = envs.data.find((e: any) => e.id === envChoice);
    p.log.info(`Using environment: ${env.name}`);
  }

  // ── Step 3: Secrets ────────────────────────────────────────────────────────
  const engineKey = (agent.engine ?? agent.backend ?? "claude") as string;
  const vaultId = await ensureEngineSecretsInteractive(b, engineKey, agent.id);

  // ── Wait for environment ───────────────────────────────────────────────────
  const ws = p.spinner();
  ws.start("Waiting for environment to be ready...");
  await waitForEnvironment(b, env.id, 120_000, 2_000);
  ws.stop("Environment is ready.");

  // ── Step 4: Session ────────────────────────────────────────────────────────
  const ss = p.spinner();
  ss.start("Creating session...");
  const sessionOpts: Record<string, unknown> = { agent: agent.id, environment_id: env.id };
  if (vaultId) sessionOpts.vault_ids = [vaultId];
  const session = await b.sessions.create(sessionOpts);
  ss.stop(`Session created: ${session.id}`);

  p.outro("Happy coding! Type a message to start chatting.");

  console.log("Type a message and press Enter. Ctrl+C to interrupt, Ctrl+D to exit.");
  console.log("─".repeat(60));
  await runChatLoop(b, session.id, { verbose, initialStatus: "idle" });
}

// ---------------------------------------------------------------------------
// Non-interactive path (non-TTY / flags only)
// ---------------------------------------------------------------------------

async function runNonInteractiveQuickstart(b: any, opts: any, verbose: boolean): Promise<void> {
  const model = opts.model || defaultModel(opts.engine);

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

  console.log("  1  Agent  →  2  Environment  →  3  Secrets  →  4  Chat\n");
  await ensureProviderTokenNonInteractive(opts.provider);
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

  console.log("  1  Agent  →  2  Environment  →  3  Secrets  →  4  Chat\n");
  const vaultId = await ensureEngineSecretsNonInteractive(b, opts.engine, agent.id);

  await waitForEnvironment(b, env.id, 120_000, 2_000);

  console.log("  1  Agent  →  2  Environment  →  3  Secrets  →  4  Chat\n");
  console.log("Creating session...");
  const sessionOpts: Record<string, unknown> = { agent: agent.id, environment_id: env.id };
  if (vaultId) sessionOpts.vault_ids = [vaultId];
  const session = await b.sessions.create(sessionOpts);
  console.log(`  Session: ${session.id}\n`);

  console.log("Type a message and press Enter. Ctrl+C to interrupt, Ctrl+D to exit.");
  console.log("─".repeat(60));
  await runChatLoop(b, session.id, { verbose, initialStatus: "idle" });
}

// ---------------------------------------------------------------------------
// Secrets helpers
// ---------------------------------------------------------------------------

const BACKEND_KEYS: Record<string, { envVars: string[]; label: string }> = {
  claude: { envVars: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"], label: "ANTHROPIC_API_KEY" },
  codex: { envVars: ["OPENAI_API_KEY"], label: "OPENAI_API_KEY" },
  opencode: { envVars: ["OPENAI_API_KEY"], label: "OPENAI_API_KEY" },
  gemini: { envVars: ["GEMINI_API_KEY"], label: "GEMINI_API_KEY" },
  factory: { envVars: ["FACTORY_API_KEY"], label: "FACTORY_API_KEY" },
  pi: { envVars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"], label: "ANTHROPIC_API_KEY" },
};

async function hasServerKey(backend: string): Promise<boolean> {
  const req = BACKEND_KEYS[backend] ?? BACKEND_KEYS.claude;
  if (req.envVars.some((k) => process.env[k])) return true;
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
    return req.envVars.some((k) => !!cfg[configKeyMap[k]]);
  } catch {
    return false;
  }
}

async function promptAndSaveToVault(b: any, req: typeof BACKEND_KEYS[string], agentId: string): Promise<string> {
  const key = await p.password({ message: `Paste your ${req.label}` });
  if (p.isCancel(key)) { p.cancel("Cancelled."); process.exit(0); }

  const trimmed = (key as string).trim();
  if (!trimmed) {
    p.log.error("No key provided.");
    process.exit(1);
  }

  let envKey = req.envVars[0];
  if (envKey === "ANTHROPIC_API_KEY" && trimmed.startsWith("sk-ant-oat")) {
    envKey = "CLAUDE_CODE_OAUTH_TOKEN";
  }

  const s = p.spinner();
  s.start("Saving key to vault...");
  const vault = await b.vaults.create({ agent_id: agentId, name: "secrets" });
  await b.vaults.entries.set(vault.id, envKey, trimmed);
  s.stop("Saved to vault.");
  return vault.id;
}

async function ensureEngineSecretsInteractive(b: any, backend: string, agentId: string): Promise<string | null> {
  const req = BACKEND_KEYS[backend] ?? BACKEND_KEYS.claude;

  if (await hasServerKey(backend)) {
    const override = await p.confirm({
      message: `${req.label} is already configured. Override with your own key?`,
      initialValue: false,
    });
    if (p.isCancel(override)) { p.cancel("Cancelled."); process.exit(0); }

    if (override) {
      return promptAndSaveToVault(b, req, agentId);
    }
    p.log.info("Using server-configured key.");
    return null;
  }

  p.log.warn(`No API key found for ${backend} backend.`);
  return promptAndSaveToVault(b, req, agentId);
}

async function ensureEngineSecretsNonInteractive(b: any, backend: string, agentId: string): Promise<string | null> {
  const req = BACKEND_KEYS[backend] ?? BACKEND_KEYS.claude;

  if (await hasServerKey(backend)) {
    console.log("Using server-configured key.\n");
    return null;
  }

  console.error(`Error: ${backend} backend requires ${req.label} to be set.\n\n  export ${req.label}=<your-key>\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Provider token helpers
// ---------------------------------------------------------------------------

interface TokenField {
  envVar: string;
  settingKey?: string; // undefined for fields the quickstart can't persist to config
  label: string;
}

/**
 * Per-provider auth requirements. Most providers need one env var; a few
 * (vercel, modal, fly) need multiple. The quickstart walks through each
 * field one-by-one and persists what it can to settings.
 *
 * Fields without a `settingKey` are printed as "also export this env var"
 * hints — the gateway settings table doesn't store them, but the user
 * needs them in their shell environment.
 */
const PROVIDER_TOKENS: Record<string, TokenField[]> = {
  anthropic: [{ envVar: "ANTHROPIC_API_KEY", settingKey: "anthropic_api_key", label: "Anthropic API Key" }],
  sprites: [{ envVar: "SPRITE_TOKEN", settingKey: "sprite_token", label: "Sprites.dev Token" }],
  e2b: [{ envVar: "E2B_API_KEY", settingKey: "e2b_api_key", label: "E2B API Key" }],
  daytona: [{ envVar: "DAYTONA_API_KEY", settingKey: "daytona_api_key", label: "Daytona API Key" }],
  vercel: [
    { envVar: "VERCEL_TOKEN", settingKey: "vercel_token", label: "Vercel Token" },
    { envVar: "VERCEL_TEAM_ID", label: "Vercel Team ID" },
    { envVar: "VERCEL_PROJECT_ID", label: "Vercel Project ID" },
  ],
  fly: [
    { envVar: "FLY_API_TOKEN", settingKey: "fly_api_token", label: "Fly.io API Token" },
    { envVar: "FLY_APP_NAME", label: "Fly App Name" },
  ],
  modal: [
    { envVar: "MODAL_TOKEN_ID", settingKey: "modal_token_id", label: "Modal Token ID" },
    { envVar: "MODAL_TOKEN_SECRET", label: "Modal Token Secret" },
  ],
};

/** Is the field populated from env or settings? */
async function fieldPresent(field: TokenField): Promise<boolean> {
  if (process.env[field.envVar]) return true;
  if (!field.settingKey) return false;
  try {
    const { getConfig } = await import("@agentstep/agent-sdk/config");
    const cfg = getConfig() as Record<string, unknown>;
    const camelKey = field.settingKey.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
    return Boolean(cfg[camelKey]);
  } catch {
    return false;
  }
}

async function providerTokenPresent(provider: string): Promise<boolean> {
  const fields = PROVIDER_TOKENS[provider];
  if (!fields) return true; // local providers don't need tokens
  for (const field of fields) {
    if (!(await fieldPresent(field))) return false;
  }
  return true;
}

async function ensureProviderTokenInteractive(provider: string): Promise<void> {
  const fields = PROVIDER_TOKENS[provider];
  if (!fields) return; // local providers

  for (const field of fields) {
    if (await fieldPresent(field)) continue;

    // Non-secret fields (team_id, app_name, project_id) use text prompt;
    // secrets use password prompt.
    const isSecret = field.envVar.toLowerCase().includes("token") || field.envVar.toLowerCase().includes("secret") || field.envVar.toLowerCase().includes("key");
    const value = isSecret
      ? await p.password({ message: `Paste your ${field.label}` })
      : await p.text({ message: `Enter your ${field.label}` });
    if (p.isCancel(value)) { p.cancel("Cancelled."); process.exit(0); }

    const trimmed = String(value).trim();
    if (!trimmed) {
      p.log.error(`${field.label} is required for the ${provider} provider.`);
      process.exit(1);
    }

    if (field.settingKey) {
      const s = p.spinner();
      s.start(`Saving ${field.label}...`);
      const { writeSetting } = await import("@agentstep/agent-sdk/config");
      writeSetting(field.settingKey, trimmed);
      s.stop(`Saved ${field.label}.`);
    } else {
      // Field can't be persisted to settings — set in-process for this run
      // and remind the user to export it in their shell.
      process.env[field.envVar] = trimmed;
      p.log.info(`Set ${field.envVar} for this session. Export it in your shell to persist.`);
    }
  }
}

async function ensureProviderTokenNonInteractive(provider: string): Promise<void> {
  const fields = PROVIDER_TOKENS[provider];
  if (!fields) return;

  const missing: string[] = [];
  for (const field of fields) {
    if (!(await fieldPresent(field))) missing.push(field.envVar);
  }
  if (missing.length === 0) return;

  const exports = missing.map((v) => `  export ${v}=<your-value>`).join("\n");
  console.error(`Error: ${provider} provider requires:\n\n${exports}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function defaultModel(backend: string): string {
  switch (backend) {
    case "opencode": return "openai/gpt-4o";
    case "codex": return "gpt-4o";
    default: return "claude-sonnet-4-6";
  }
}
