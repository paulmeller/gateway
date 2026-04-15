/**
 * Build the `codex exec` argv for one turn.
 *
 * Ported from
 * 
 *
 * Codex-specific constraints:
 * - No --max-turns (codex has no equivalent; silently ignored like opencode)
 * - No --system-prompt flag — system prompt is wrapped into the user prompt
 *   text via the shared wrapPromptWithSystem utility
 * - MCP is passed via -c config flags (not env var like opencode)
 * - Trailing `-` reads prompt from stdin (promptViaStdin: true — like claude)
 * - --full-auto + --ask-for-approval never + --dangerously-bypass-approvals-
 *   and-sandbox to prevent headless hangs
 */
import type { Agent } from "../../types";

export interface BuildCodexArgsInput {
  agent: Agent;
}

export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  // --full-auto alone is sufficient for
  // non-interactive headless execution on v0.118.0. Flags like
  // --ask-for-approval and --dangerously-bypass-approvals-and-sandbox
  // do NOT exist in the current codex Rust CLI.
  const args = [
    "exec",
    "--json",
    "--full-auto",
    "--skip-git-repo-check",
  ];

  if (input.agent.model) {
    // Codex expects bare model names (gpt-5.4, gpt-5.4-mini) — NOT the
    // openai/gpt-5.4 format opencode uses.
    args.push("--model", input.agent.model);
  }

  // MCP config via -c flags (/lib/oc/cli-providers.ts:219-235)
  if (input.agent.mcp_servers) {
    for (const [name, server] of Object.entries(input.agent.mcp_servers)) {
      if (server.type) {
        args.push("-c", `mcp_servers.${name}.type="${server.type}"`);
      }
      if (server.url) {
        args.push("-c", `mcp_servers.${name}.url="${server.url}"`);
      }
      if (typeof server.command === "string") {
        args.push("-c", `mcp_servers.${name}.command="${server.command}"`);
      }
      if (server.args && server.args.length > 0) {
        args.push(
          "-c",
          `mcp_servers.${name}.args=${JSON.stringify(server.args)}`,
        );
      }
      if (server.headers) {
        for (const [hk, hv] of Object.entries(server.headers)) {
          args.push("-c", `mcp_servers.${name}.http_headers.${hk}="${hv}"`);
        }
      }
    }
  }

  // Trailing `-` signals stdin prompt
  args.push("-");
  return args;
}
