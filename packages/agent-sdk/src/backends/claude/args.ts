/**
 * Build the `claude -p` argv for one turn.
 *
 * Collapses multi-CLI
 * 
 * down to the claude-only shape this service needs.
 *
 * Always emits:
 *   -p --output-format stream-json --verbose
 *   --permission-mode bypassPermissions --max-turns <N>
 *
 * Adds `--resume <claude_session_id>` on every turn ≥ 2 using the most
 * recently observed id from the previous turn's `system.init`.
 */
import { getConfig } from "../../config";
import { withGatewayPreamble } from "../shared/wrap-prompt";
import type { Agent, McpServerConfig } from "../../types";
import { resolveToolset } from "../../sessions/tools";

export interface BuildArgsInput {
  agent: Agent;
  claudeSessionId?: string | null;
  maxTurns?: number;
  confirmationMode?: boolean;
}

export function buildClaudeArgs(input: BuildArgsInput): string[] {
  const cfg = getConfig();
  const permissionMode = input.confirmationMode ? "default" : "bypassPermissions";
  const argv: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    permissionMode,
  ];

  // Only cap turns if explicitly configured (default 0 = unlimited, like Anthropic MA)
  const maxTurns = input.maxTurns ?? cfg.agentMaxTurns;
  if (maxTurns > 0) {
    argv.push("--max-turns", String(maxTurns));
  }

  if (input.claudeSessionId) {
    argv.push("--resume", input.claudeSessionId);
  }

  const tools = resolveToolset(input.agent.tools);

  // Build system prompt with gateway preamble + custom tool hints
  let systemPrompt = withGatewayPreamble(input.agent.system);
  if (tools.customToolNames.size > 0) {
    const toolList = Array.from(tools.customToolNames)
      .map((name) => `mcp__tool-bridge__${name}`)
      .join(", ");
    systemPrompt += `\n\nYour custom tools are: ${toolList}. Call them by these exact names — do not use ToolSearch to find them.`;
  }
  argv.push("--system-prompt", systemPrompt);

  if (input.agent.model) {
    argv.push("--model", input.agent.model);
  }

  // Add MCP-namespaced custom tool names so Claude Code's ToolSearch
  // can discover them. MCP tools are registered as mcp__<server>__<name>.
  const mcpToolNames = Array.from(tools.customToolNames).map(
    (name) => `mcp__tool-bridge__${name}`,
  );
  const allAllowed = [...tools.allowedTools, ...mcpToolNames];
  if (allAllowed.length) {
    argv.push("--allowed-tools", allAllowed.join(","));
  }
  if (tools.disallowedTools.length) {
    argv.push("--disallowed-tools", tools.disallowedTools.join(","));
  }

  if (input.agent.model_config?.speed === "fast") {
    argv.push("--fast");
  }

  if (input.agent.mcp_servers && Object.keys(input.agent.mcp_servers).length > 0) {
    argv.push(
      "--mcp-config",
      JSON.stringify({ mcpServers: input.agent.mcp_servers satisfies Record<string, McpServerConfig> }),
    );
  }

  return argv;
}

/**
 * Return the auth env vars for claude as a key-value map. The driver
 * composes these into the wrapper stdin as `KEY=value` lines.
 */
export function buildClaudeAuthEnv(): Record<string, string> {
  const cfg = getConfig();
  const env: Record<string, string> = {};

  const token = cfg.claudeToken || cfg.anthropicApiKey;
  if (token) {
    if (token.startsWith("sk-ant-oat")) {
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
    } else {
      env.ANTHROPIC_API_KEY = token;
    }
  }

  return env;
}
