/**
 * MCP config translation for opencode.
 *
 * Opencode loads its MCP config from the `OPENCODE_CONFIG_CONTENT` env var
 * (not from a `--mcp-config` CLI flag). The JSON shape is slightly
 * different from claude's:
 *
 *   Claude:                 Opencode:
 *   type: "stdio"     --->  type: "local", command: [cmd, ...args]
 *   type: "http"      --->  type: "remote"
 *   type: "sse"       --->  type: "remote"
 *
 * Ported verbatim from
 * 
 */
import type { Agent, McpServerConfig } from "../../types";

/** Opencode's MCP server config shape (distinct from claude's). */
export interface OpencodeMcpServer {
  type?: "local" | "remote";
  url?: string;
  command?: string | string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export function mcpConfigToOpencode(
  mcpConfig: Record<string, McpServerConfig>,
): Record<string, OpencodeMcpServer> {
  const mcp: Record<string, OpencodeMcpServer> = {};

  for (const [name, server] of Object.entries(mcpConfig)) {
    const entry: OpencodeMcpServer = {
      url: server.url,
      headers: server.headers,
      env: server.env,
    };

    if (server.type === "stdio") {
      entry.type = "local";
      // stdio uses command:string + args:array; opencode wants command:array
      if (typeof server.command === "string") {
        entry.command = [server.command, ...(server.args || [])];
      } else if (Array.isArray(server.command)) {
        entry.command = [...server.command, ...(server.args || [])];
      }
    } else if (server.type === "http" || server.type === "sse") {
      entry.type = "remote";
    }

    mcp[name] = entry;
  }

  return mcp;
}

/**
 * Return env vars that carry the agent's MCP config to opencode.
 * Returns an empty map if the agent has no MCP servers.
 */
export function buildOpencodeMcpEnv(agent: Agent): Record<string, string> {
  if (!agent.mcp_servers || Object.keys(agent.mcp_servers).length === 0) {
    return {};
  }
  const opencodeMcp = mcpConfigToOpencode(agent.mcp_servers);
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: opencodeMcp }) };
}
