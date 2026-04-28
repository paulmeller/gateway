/**
 * Build the `codex exec` argv for one turn.
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
  // --full-auto is sufficient for headless execution on Docker/Podman
  // (uses WorkspaceWrite sandbox via bwrap). On Firecracker providers
  // (sprites, fly, apple-firecracker), the driver swaps this for
  // --dangerously-bypass-approvals-and-sandbox (DangerFullAccess)
  // because bwrap requires user namespaces that Firecracker VMs don't
  // expose. The two flags conflict — only one can be used at a time.
  const args = [
    "exec",
    "--json",
    "--full-auto",
    "--skip-git-repo-check",
  ];

  if (input.agent.model) {
    args.push("--model", input.agent.model);

    // Ollama models: add --oss --local-provider ollama flags.
    // Ollama model names don't start with known cloud prefixes.
    const cloudPrefixes = ["claude-", "gpt-", "o1-", "o3-", "o4-", "codex-", "chatgpt-"];
    const isOllama = !input.agent.model.includes("/") && !cloudPrefixes.some(p => input.agent.model.startsWith(p));
    if (isOllama) {
      args.push("--oss", "--local-provider", "ollama");
    }
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
