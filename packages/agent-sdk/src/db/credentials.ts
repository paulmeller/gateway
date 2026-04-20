/**
 * Vault credentials: Anthropic-compatible structured auth stored per vault.
 *
 * Credentials wrap a secret token with metadata (display_name, auth_type,
 * optional mcp_server_url). The token is AES-256-GCM encrypted at rest
 * using the same machinery as vault entries.
 */
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import { encryptValue, decryptValue } from "./vault-crypto";
import type { VaultCredential, VaultCredentialRow } from "../types";

function hydrate(row: VaultCredentialRow): VaultCredential {
  return {
    id: row.id,
    vault_id: row.vault_id,
    display_name: row.display_name,
    auth: {
      type: row.auth_type,
      mcp_server_url: row.mcp_server_url,
    },
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function createCredential(input: {
  vault_id: string;
  display_name: string;
  auth_type: string;
  token: string;
  mcp_server_url?: string | null;
}): VaultCredential {
  const db = getDb();
  const id = newId("vcrd");
  const now = nowMs();
  const encrypted = encryptValue(input.token);
  db.prepare(
    `INSERT INTO vault_credentials (id, vault_id, display_name, auth_type, auth_token_encrypted, mcp_server_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.vault_id, input.display_name, input.auth_type, encrypted, input.mcp_server_url ?? null, now, now);
  return getCredential(id)!;
}

export function getCredential(id: string): VaultCredential | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM vault_credentials WHERE id = ?`).get(id) as VaultCredentialRow | undefined;
  return row ? hydrate(row) : null;
}

export function listCredentials(vaultId: string): VaultCredential[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM vault_credentials WHERE vault_id = ? ORDER BY created_at DESC`).all(vaultId) as VaultCredentialRow[];
  return rows.map(hydrate);
}

/** Returns the decrypted token for a credential. Used by the secrets loader at turn start. */
export function getCredentialToken(id: string): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT auth_token_encrypted FROM vault_credentials WHERE id = ?`).get(id) as { auth_token_encrypted: string } | undefined;
  if (!row) return null;
  return decryptValue(row.auth_token_encrypted);
}

/** List credentials with decrypted tokens -- used by the unified secrets loader. */
export function listCredentialsWithTokens(vaultId: string): Array<VaultCredential & { token: string }> {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM vault_credentials WHERE vault_id = ? ORDER BY created_at DESC`).all(vaultId) as VaultCredentialRow[];
  return rows.map(row => ({
    ...hydrate(row),
    token: decryptValue(row.auth_token_encrypted),
  }));
}

export function updateCredential(id: string, input: {
  display_name?: string;
  auth_type?: string;
  token?: string;
  mcp_server_url?: string | null;
}): VaultCredential | null {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM vault_credentials WHERE id = ?`).get(id) as VaultCredentialRow | undefined;
  if (!existing) return null;
  const now = nowMs();
  const parts: string[] = ["updated_at = ?"];
  const args: unknown[] = [now];
  if (input.display_name !== undefined) { parts.push("display_name = ?"); args.push(input.display_name); }
  if (input.auth_type !== undefined) { parts.push("auth_type = ?"); args.push(input.auth_type); }
  if (input.token !== undefined) { parts.push("auth_token_encrypted = ?"); args.push(encryptValue(input.token)); }
  if (input.mcp_server_url !== undefined) { parts.push("mcp_server_url = ?"); args.push(input.mcp_server_url); }
  db.prepare(`UPDATE vault_credentials SET ${parts.join(", ")} WHERE id = ?`).run(...args, id);
  return getCredential(id);
}

export function deleteCredential(id: string): boolean {
  const db = getDb();
  const res = db.prepare(`DELETE FROM vault_credentials WHERE id = ?`).run(id);
  return res.changes > 0;
}
