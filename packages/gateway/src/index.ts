import { Command } from "commander";
import type { Backend } from "./backend/interface.js";
import { resolveBackend } from "./backend/resolve.js";
import { loadConfig, effectiveApiKey, effectiveBaseUrl, effectiveOutput } from "./config/file.js";
import { resolveFormat, type OutputFormat } from "./output/format.js";
import { registerAgentCommands } from "./commands/agents.js";
import { registerEnvironmentCommands } from "./commands/environments.js";
import { registerSessionCommands } from "./commands/sessions.js";
import { registerEventCommands } from "./commands/events.js";
import { registerVaultCommands } from "./commands/vaults.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerBatchCommand } from "./commands/batch.js";
import { registerChatCommand } from "./commands/chat.js";
import { registerQuickstartCommand } from "./commands/quickstart.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerVersionCommand } from "./commands/version.js";
import { registerSkillsCommands } from "./commands/skills.js";
import { registerProviderCommands } from "./commands/providers.js";
import { registerDbCommands } from "./commands/db.js";
import { registerTenantCommands } from "./commands/tenants.js";
import { registerUpstreamKeyCommands } from "./commands/upstream_keys.js";
import { registerAuditCommands } from "./commands/audit.js";
import { ensureTelemetryConsent, trackCommand } from "./telemetry/index.js";

const program = new Command("gateway")
  .description("AgentStep Gateway CLI.\nOne API. Any agent. Your infrastructure.")
  .option("--remote <url>", "Remote server URL (enables remote mode)")
  .option("-o, --output <format>", "Output format: table, json")
  .option("--no-color", "Disable colored output")
  .option("-v, --verbose", "Verbose output")
  .hook("preAction", () => {
    // Wire --no-color to chalk and NO_COLOR env var
    if (!program.opts().color || process.env.NO_COLOR) {
      process.env.FORCE_COLOR = "0";
    }
  })
  .hook("preAction", async (_thisCmd, actionCommand) => {
    const name = actionCommand.name();
    // Skip telemetry consent for non-network / admin commands so they can
    // run offline and don't trigger any surrounding init that might open
    // the DB (important for `db reset`, which needs the file free).
    // Skip network-triggering telemetry for pure local-DB admin commands.
    // Check parent.name() to disambiguate "create" (agents vs tenants etc.).
    const parentName = actionCommand.parent?.name();
    if (name === "config" || name === "version" || name === "reset" || name === "audit") return;
    if (parentName === "tenants" || parentName === "upstream-keys") return;
    await ensureTelemetryConsent();
  })
  .hook("postAction", (_thisCmd, actionCommand) => {
    const parts: string[] = [];
    let cmd: Command | null = actionCommand;
    while (cmd && cmd !== program) {
      parts.unshift(cmd.name());
      cmd = cmd.parent;
    }
    trackCommand({
      command: parts.join(" "),
      backendType: program.opts().remote ? "remote" : "local",
      success: true,
    });
  });

// Lazy backend resolution
let _backend: Backend | undefined;
let _format: OutputFormat | undefined;

/** Get or create the backend, and initialize it. Single call replaces getBackend() + init(). */
export async function initBackend(): Promise<Backend> {
  const b = getBackend();
  await b.init();
  return b;
}

export function getBackend(): Backend {
  if (!_backend) {
    const cfg = loadConfig();
    const apiKey = effectiveApiKey(cfg);
    // --remote flag takes precedence, then base-url config/env
    const remote = program.opts().remote;
    const baseUrl = effectiveBaseUrl(cfg);
    // Use remote mode if --remote is set, or if base-url is configured to something non-default
    const useRemote = remote || (baseUrl !== "http://localhost:3000" && cfg["base-url"]);
    const remoteUrl = remote || baseUrl;
    _backend = resolveBackend(useRemote ? { remote: remoteUrl, apiKey } : {});
  }
  return _backend;
}

export function getFormat(): OutputFormat {
  if (!_format) {
    const cfg = loadConfig();
    _format = resolveFormat(program.opts().output, effectiveOutput(cfg));
  }
  return _format;
}

export function isLongRunning(): boolean {
  // Commands that should NOT call process.exit
  const args = process.argv.slice(2);
  const longRunning = ["chat", "serve", "quickstart", "stream"];
  return longRunning.some((cmd) => args.includes(cmd));
}

// Register all commands
registerAgentCommands(program);
registerEnvironmentCommands(program);
registerSessionCommands(program);
registerEventCommands(program);
registerVaultCommands(program);
registerMemoryCommands(program);
registerBatchCommand(program);
registerChatCommand(program);
registerQuickstartCommand(program);
registerServeCommand(program);
registerSkillsCommands(program);
registerProviderCommands(program);
registerConfigCommands(program);
registerVersionCommand(program);
registerDbCommands(program);
registerTenantCommands(program);
registerUpstreamKeyCommands(program);
registerAuditCommands(program);

// Parse and run
program.parseAsync(process.argv).then(() => {
  if (!isLongRunning()) {
    process.exit(0);
  }
}).catch((err) => {
  // Only report the command *name* (first non-flag arg chain), never
  // the raw argv — positional args can contain secrets
  // (`gateway vaults put-entry vlt_xxx KEY sk-ant-...`).
  // Example: `gateway vaults put-entry vlt_xxx KEY sk-ant-abc -o json` → "vaults put-entry"
  const cmdName = process.argv.slice(2).filter((a) => !a.startsWith("-")).slice(0, 2).join(" ") || "unknown";
  trackCommand({
    command: cmdName,
    backendType: program.opts().remote ? "remote" : "local",
    success: false,
  });
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
