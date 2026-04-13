/**
 * Resolve vault entries into a flat secrets map for provider auth.
 *
 * Called once per session at container creation time. The resulting
 * map is stored in the pool entry and passed to provider methods
 * via the `secrets` parameter.
 */
import { listEntries } from "../db/vaults";

export const BLOCKED_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "SHELL",
  "LD_PRELOAD", "LD_LIBRARY_PATH",
  "NODE_PATH", "NODE_OPTIONS",
]);

export function resolveVaultSecrets(vaultIds: string[]): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const vid of vaultIds) {
    for (const { key, value } of listEntries(vid)) {
      if (!BLOCKED_ENV_KEYS.has(key)) secrets[key] = value;
    }
  }
  return secrets;
}
