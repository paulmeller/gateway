/**
 * Authentication middleware.
 *
 * Extracts an API key from `x-api-key` (preferred per Managed Agents spec)
 * or `Authorization: Bearer <token>`. Hashes with sha256 and looks it up in
 * the `api_keys` table. Returns an AuthContext on success.
 *
 * Simplified rewrite of
 *  —
 * no WorkOS, no grace cache, no admin bypass key.
 */
import { findByRawKey } from "../db/api_keys";
import type { AuthContext } from "../types";
import { unauthorized } from "../errors";

export function extractKey(request: Request): string | null {
  const xKey = request.headers.get("x-api-key");
  if (xKey && xKey.length > 0) return xKey;

  const auth = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : null;
}

export async function authenticate(request: Request): Promise<AuthContext> {
  const key = extractKey(request);
  if (!key) throw unauthorized();

  const row = findByRawKey(key);
  if (!row) throw unauthorized();

  return {
    keyId: row.id,
    name: row.name,
    permissions: JSON.parse(row.permissions_json) as string[],
  };
}
