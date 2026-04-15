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
    "--max-turns",
    String(input.maxTurns ?? cfg.agentMaxTurns),
  ];

  if (input.claudeSessionId) {
    argv.push("--resume", input.claudeSessionId);
  }

  if (input.agent.system) {
    argv.push("--system-prompt", input.agent.system);
  }

  if (input.agent.model) {
    argv.push("--model", input.agent.model);
  }

  const tools = resolveToolset(input.agent.tools);
  if (tools.allowedTools.length) {
    argv.push("--allowed-tools", tools.allowedTools.join(","));
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
