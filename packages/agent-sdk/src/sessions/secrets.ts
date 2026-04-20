/**
 * Unified secret loader -- combines vault entries and credentials into
 * a single list of key-value pairs for driver injection.
 *
 * Credentials with mcp_server_url are automatically mapped to
 * MCP_AUTH_{SERVER_NAME} keys at load time (not at write time). This
 * eliminates the need for companion entries in the vault_entries table.
 */
import { listEntries } from "../db/vaults";
import { listCredentialsWithTokens } from "../db/credentials";

export interface SessionSecret {
  key: string;
  value: string;
}

/**
 * Load all secrets for a set of vault IDs. Returns vault entries + credential
 * tokens (the latter mapped to MCP_AUTH_* keys when mcp_server_url is present).
 */
export function loadSessionSecrets(vaultIds: string[]): SessionSecret[] {
  const secrets: SessionSecret[] = [];

  for (const vid of vaultIds) {
    // 1. Standard vault entries
    for (const entry of listEntries(vid)) {
      secrets.push({ key: entry.key, value: entry.value });
    }

    // 2. Credentials -> derive MCP_AUTH_* keys from mcp_server_url
    for (const cred of listCredentialsWithTokens(vid)) {
      if (cred.auth.mcp_server_url) {
        // Derive a server name from the URL: extract hostname, strip common prefixes
        const serverName = deriveServerName(cred.auth.mcp_server_url);
        if (serverName) {
          const key = `MCP_AUTH_${serverName.toUpperCase().replace(/-/g, "_")}`;
          secrets.push({ key, value: cred.token });
        }
      }
      // Also inject the raw token under a predictable key so it's available as an env var
      secrets.push({
        key: `CREDENTIAL_${cred.display_name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
        value: cred.token,
      });
    }
  }

  return secrets;
}

/**
 * Derive a server name from an MCP server URL.
 * Example: "https://mcp.github.com" -> "GITHUB"
 *          "https://api.xero.com/mcp" -> "XERO"
 */
export function deriveServerName(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    // Strip common prefixes/suffixes
    const cleaned = host
      .replace(/^(mcp|api|www)\./, "")
      .replace(/\.(com|io|dev|ai|org|net)$/, "")
      .replace(/\./g, "_");
    return cleaned || null;
  } catch {
    return null;
  }
}
