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
import { getUserProfile } from "../db/user-profiles";

export interface SessionSecret {
  key: string;
  value: string;
}

/**
 * Load all secrets for a set of vault IDs. Returns vault entries + credential
 * tokens (the latter mapped to MCP_AUTH_* keys when mcp_server_url is present).
 *
 * When userProfileId is provided, credentials are filtered by the profile's
 * trust_grants — only credentials explicitly granted to the user are loaded.
 * Vault entries (key/value) are always loaded regardless of profile.
 */
export function loadSessionSecrets(vaultIds: string[], userProfileId?: string | null): SessionSecret[] {
  // Build credential allowlist from user profile trust grants
  let credentialAllowlist: Set<string> | null = null;
  if (userProfileId) {
    const profile = getUserProfile(userProfileId);
    if (profile && profile.trust_grants.length > 0) {
      credentialAllowlist = new Set(
        profile.trust_grants.map(g => `${g.vault_id}:${g.credential_id}`)
      );
    }
  }

  const secrets: SessionSecret[] = [];

  for (const vid of vaultIds) {
    // 1. Standard vault entries — always loaded, not filtered by profile
    for (const entry of listEntries(vid)) {
      secrets.push({ key: entry.key, value: entry.value });
    }

    // 2. Credentials -> derive MCP_AUTH_* keys from mcp_server_url
    //    Filtered by trust grants when a user profile is set.
    for (const cred of listCredentialsWithTokens(vid)) {
      if (credentialAllowlist && !credentialAllowlist.has(`${vid}:${cred.id}`)) continue;

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
