/**
 * Unified upstream-key resolution for supported providers.
 *
 * Cascade, highest precedence first:
 *   1. Session's vault entries (per-provider named key)
 *   2. Upstream-key pool (LRU-selected active row)
 *   3. Config cascade (env var, then settings table)
 *
 * Providers (v0.5):
 *   - anthropic: rejects `sk-ant-oat*` OAuth tokens — the managed-agents
 *     proxy path requires real API keys. Vault key: ANTHROPIC_API_KEY.
 *   - openai: vault key OPENAI_API_KEY. Config: config.openAiApiKey.
 *   - gemini: vault key GEMINI_API_KEY. Config: config.geminiApiKey.
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

export const SUPPORTED_PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type UpstreamProvider = typeof SUPPORTED_PROVIDERS[number];

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

function rejectOAuth(provider: UpstreamProvider, value: string | null | undefined): string | null {
  if (!value) return null;
  // Anthropic: managed-agents proxy refuses OAuth tokens; reject them
  // up-front so the user gets a clean error from the wizard instead of a
  // confusing 401 from the upstream.
  if (provider === "anthropic" && value.startsWith("sk-ant-oat")) return null;
  return value;
}

/** Lookup table: provider → vault entry key name. */
const VAULT_KEY_FOR: Record<UpstreamProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai:    "OPENAI_API_KEY",
  gemini:    "GEMINI_API_KEY",
};

function configKeyFor(provider: UpstreamProvider): string | undefined {
  const cfg = getConfig();
  switch (provider) {
    case "anthropic": return cfg.anthropicApiKey;
    case "openai":    return cfg.openAiApiKey;
    case "gemini":    return cfg.geminiApiKey;
  }
}

/**
 * Resolve a provider's API key for a session or a standalone context.
 *
 * @param provider     — which upstream provider to resolve (anthropic/openai/gemini)
 * @param opts.sessionId — if present, vault lookup via the session's vault_ids.
 * @param opts.vaultIds  — explicit vault id list (if you don't have a session yet).
 *
 * Returns null when no source supplied a valid key.
 */
export function resolveProviderKey(
  provider: UpstreamProvider,
  opts: { sessionId?: string; vaultIds?: string[] } = {},
): ResolvedKey | null {
  const vaultKeyName = VAULT_KEY_FOR[provider];

  // 1. Vault (if session or vaultIds provided)
  let vaultIds: string[] | undefined = opts.vaultIds;
  if (!vaultIds && opts.sessionId) {
    const session = getSession(opts.sessionId);
    vaultIds = session?.vault_ids ?? undefined;
  }
  if (vaultIds?.length) {
    for (const vid of vaultIds) {
      const entries = listEntries(vid);
      const found = entries.find(e => e.key === vaultKeyName);
      const clean = rejectOAuth(provider, found?.value);
      if (clean) return { value: clean, poolId: null };
    }
  }

  // 2. Upstream-key pool (LRU selection, per-provider).
  const pooled = selectNextUpstreamKey(provider);
  if (pooled) {
    const clean = rejectOAuth(provider, pooled.value);
    if (clean) return { value: clean, poolId: pooled.id };
  }

  // 3. Config cascade (env var → settings table)
  const clean = rejectOAuth(provider, configKeyFor(provider));
  if (clean) return { value: clean, poolId: null };

  return null;
}

/**
 * Back-compat shim — Anthropic was the only supported provider in v0.4.
 * New code should call `resolveProviderKey("anthropic", opts)`.
 */
export function resolveAnthropicKey(opts: { sessionId?: string; vaultIds?: string[] } = {}): ResolvedKey | null {
  return resolveProviderKey("anthropic", opts);
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
