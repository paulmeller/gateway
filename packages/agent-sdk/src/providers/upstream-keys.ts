/**
 * Unified upstream-key resolution for the Anthropic provider.
 *
 * Cascade, highest precedence first:
 *   1. Session's vault entries (ANTHROPIC_API_KEY)
 *   2. Upstream-key pool (LRU-selected active row)
 *   3. Config cascade (env var ANTHROPIC_API_KEY, then settings table)
 *
 * Rejects `sk-ant-oat*` OAuth tokens — Anthropic's Managed Agents API
 * requires real API keys.
 *
 * Failure tracking: in-memory consecutive-failure counter per pool
 * key-id. Reports are best-effort — they're not required to keep the
 * gateway working, just to prevent hammering a bad key. On 3 consecutive
 * failures the pool row's `disabled_at` is set persistently.
 */
import { listEntries } from "../db/vaults";
import { getSession } from "../db/sessions";
import { selectNextUpstreamKey, disableUpstreamKey } from "../db/upstream_keys";
import { getConfig } from "../config";

const CONSECUTIVE_FAIL_THRESHOLD = 3;

/** HMR-safe per-provider failure counter: keyed on upstream_keys.id. */
type GlobalFailStore = typeof globalThis & {
  __caUpstreamKeyFailures?: Map<string, number>;
};
const g = globalThis as GlobalFailStore;
if (!g.__caUpstreamKeyFailures) g.__caUpstreamKeyFailures = new Map();
const failures = g.__caUpstreamKeyFailures;

export interface ResolvedKey {
  value: string;
  /** Pool row id if the key came from the pool. null for vault/config sources. */
  poolId: string | null;
}

function rejectOAuth(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("sk-ant-oat")) return null;
  return value;
}

/**
 * Resolve an Anthropic API key for a session or a standalone context.
 *
 * @param opts.sessionId — if present, vault lookup via the session's vault_ids.
 * @param opts.vaultIds  — explicit vault id list (if you don't have a session yet).
 *
 * Returns null when no source supplied a valid (non-OAuth) key.
 */
export function resolveAnthropicKey(opts: { sessionId?: string; vaultIds?: string[] } = {}): ResolvedKey | null {
  // 1. Vault (if session or vaultIds provided)
  let vaultIds: string[] | undefined = opts.vaultIds;
  if (!vaultIds && opts.sessionId) {
    const session = getSession(opts.sessionId);
    vaultIds = session?.vault_ids ?? undefined;
  }
  if (vaultIds?.length) {
    for (const vid of vaultIds) {
      const entries = listEntries(vid);
      const found = entries.find(e => e.key === "ANTHROPIC_API_KEY");
      const clean = rejectOAuth(found?.value);
      if (clean) return { value: clean, poolId: null };
    }
  }

  // 2. Upstream-key pool (LRU selection, per-provider).
  const pooled = selectNextUpstreamKey("anthropic");
  if (pooled) {
    const clean = rejectOAuth(pooled.value);
    if (clean) return { value: clean, poolId: pooled.id };
  }

  // 3. Config cascade (env var → settings table)
  const cfg = getConfig();
  const clean = rejectOAuth(cfg.anthropicApiKey);
  if (clean) return { value: clean, poolId: null };

  return null;
}

/**
 * Report an upstream failure for a pool key. Increments the in-memory
 * counter; on the Nth consecutive failure, disables the row in the DB.
 * No-op when the key came from vault or config.
 */
export function reportUpstreamFailure(poolId: string | null | undefined): void {
  if (!poolId) return;
  const count = (failures.get(poolId) ?? 0) + 1;
  failures.set(poolId, count);
  if (count >= CONSECUTIVE_FAIL_THRESHOLD) {
    disableUpstreamKey(poolId);
    failures.delete(poolId);
  }
}

/** Report a successful upstream call — resets the failure counter. */
export function reportUpstreamSuccess(poolId: string | null | undefined): void {
  if (!poolId) return;
  failures.delete(poolId);
}
