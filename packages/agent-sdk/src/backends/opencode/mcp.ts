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

/** Detect whether a model is a local Ollama model. */
function isOllamaModel(model: string): boolean {
  if (model.includes("/")) return false;
  const cloudPrefixes = ["claude-", "gpt-", "o1-", "o3-", "o4-", "codex-", "chatgpt-", "gemini-"];
  return !cloudPrefixes.some(p => model.startsWith(p));
}

/**
 * Return env vars that carry the agent's MCP + provider config to opencode.
 * Merges MCP server config and Ollama provider config into a single
 * OPENCODE_CONFIG_CONTENT JSON object.
 */
export function buildOpencodeConfigEnv(agent: Agent, ollamaBaseUrl?: string | undefined): Record<string, string> {
  // Default Ollama URL — the driver overrides OLLAMA_HOST per-provider later
  if (ollamaBaseUrl === undefined && isOllamaModel(agent.model)) {
    ollamaBaseUrl = "http://localhost:11434/v1";
  }
  const config: Record<string, unknown> = {};

  // MCP servers
  if (agent.mcp_servers && Object.keys(agent.mcp_servers).length > 0) {
    config.mcp = mcpConfigToOpencode(agent.mcp_servers);
  }

  // Ollama provider — register the model so opencode can route to it
  if (isOllamaModel(agent.model) && ollamaBaseUrl) {
    config.provider = {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ollama (local)",
        options: { baseURL: ollamaBaseUrl },
        models: {
          [agent.model]: { name: agent.model },
        },
      },
    };
  }

  if (Object.keys(config).length === 0) return {};
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

/** @deprecated Use buildOpencodeConfigEnv instead */
export const buildOpencodeMcpEnv = (agent: Agent) => buildOpencodeConfigEnv(agent);
