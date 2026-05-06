/**
 * MCP auth header injection — bridges vault credentials into MCP server headers.
 *
 * Convention:
 *   MCP_AUTH_{SERVER}         → Authorization: Bearer {value}
 *   MCP_HEADER_{SERVER}_{H}   → {H}: {value}  (custom header)
 *
 * Server name matching is case-insensitive with hyphens converted to
 * underscores (e.g. vault key "MCP_AUTH_MY_SERVER" matches MCP server
 * "my-server").
 *
 * Returns a shallow copy of the agent with merged headers — the original
 * agent object is not mutated.
 */
import type { Agent } from "../types";

export function injectMcpAuthHeaders(
  agent: Agent,
  vaultEntries: Array<{ key: string; value: string }>,
): Agent {
  const mcpServers = agent.mcp_servers;
  if (!mcpServers || mcpServers.length === 0) return agent;
  if (vaultEntries.length === 0) return agent;

  // Build a lookup: normalized server name → index in the array
  const serverLookup = new Map<string, number>();
  for (let i = 0; i < mcpServers.length; i++) {
    const name = mcpServers[i].name;
    serverLookup.set(name.toUpperCase().replace(/-/g, "_"), i);
  }

  let mutated = false;
  const merged: Record<number, Record<string, string>> = {};

  for (const { key, value } of vaultEntries) {
    // MCP_AUTH_{SERVER} → Authorization: Bearer
    const authMatch = /^MCP_AUTH_(.+)$/i.exec(key);
    if (authMatch) {
      const norm = authMatch[1].toUpperCase();
      const idx = serverLookup.get(norm);
      if (idx !== undefined) {
        merged[idx] = merged[idx] ?? {};
        merged[idx]["Authorization"] = `Bearer ${value}`;
        mutated = true;
      }
      continue;
    }

    // MCP_HEADER_{SERVER}_{HEADER_NAME}
    // Try progressively shorter server name matches to handle multi-part names
    const headerPrefix = /^MCP_HEADER_/i;
    if (headerPrefix.test(key)) {
      const rest = key.replace(headerPrefix, "");
      const parts = rest.split("_");
      for (let i = parts.length - 1; i >= 1; i--) {
        const serverPart = parts.slice(0, i).join("_").toUpperCase();
        const headerPart = parts.slice(i).join("-");
        const idx = serverLookup.get(serverPart);
        if (idx !== undefined) {
          merged[idx] = merged[idx] ?? {};
          merged[idx][headerPart] = value;
          mutated = true;
          break;
        }
      }
    }
  }

  if (!mutated) return agent;

  // Shallow-copy agent and mcp_servers array, merging headers
  const newServers = mcpServers.map((server, idx) => {
    const headers = merged[idx];
    if (!headers) return server;
    return {
      ...server,
      headers: { ...(server.headers as Record<string, string> | undefined), ...headers },
    };
  });

  return { ...agent, mcp_servers: newServers };
}
