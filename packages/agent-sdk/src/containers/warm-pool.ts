/**
 * Pre-session warm container pool.
 *
 * Maintains a set of pre-created, engine-prepped containers per environment so
 * that `acquireForFirstTurn` can assign one instantly (skipping the expensive
 * create + prepareOnSandbox step) and replenish in the background.
 *
 * State is in-memory only — warm entries do not survive a server restart.
 * The sweeper calls `expireWarm()` each tick to evict and delete stale entries.
 */

export interface WarmEntry {
  sandboxName: string;
  envId: string;
  /** Backend/engine name — must match at claim time. */
  engine: string;
  /** Provider name — must match at claim time. */
  provider: string;
  createdAt: number;
  /** Epoch ms after which the entry should be evicted by the sweeper. */
  expiresAt: number;
  /** Provider secrets resolved at warm-pool fill time (env-level only). */
  vaultSecrets?: Record<string, string>;
}

type WarmPoolState = {
  byEnv: Map<string, WarmEntry[]>;
  /** In-progress replenishment count per envId — prevents concurrent over-provisioning. */
  inflight: Map<string, number>;
};

type GlobalWarmPool = typeof globalThis & { __caWarmPool?: WarmPoolState };
const g = globalThis as GlobalWarmPool;

function state(): WarmPoolState {
  if (!g.__caWarmPool) {
    g.__caWarmPool = { byEnv: new Map(), inflight: new Map() };
  }
  return g.__caWarmPool;
}

/** Add a warm entry for an environment. */
export function addWarm(entry: WarmEntry): void {
  const s = state();
  const list = s.byEnv.get(entry.envId) ?? [];
  list.push(entry);
  s.byEnv.set(entry.envId, list);
}

/**
 * Claim the first warm entry matching envId, engine, and provider.
 * Removes and returns the entry, or returns null if none available.
 */
export function claimWarm(
  envId: string,
  engine: string,
  provider: string,
): WarmEntry | null {
  const s = state();
  const list = s.byEnv.get(envId);
  if (!list || list.length === 0) return null;

  const idx = list.findIndex(
    (e) => e.engine === engine && e.provider === provider,
  );
  if (idx === -1) return null;

  const [entry] = list.splice(idx, 1);
  if (list.length === 0) s.byEnv.delete(envId);
  return entry;
}

/**
 * Drop all entries past their `expiresAt` timestamp.
 * Returns the expired entries so the caller can delete their containers.
 */
export function expireWarm(now: number = Date.now()): WarmEntry[] {
  const s = state();
  const expired: WarmEntry[] = [];

  for (const [envId, list] of s.byEnv) {
    const keep: WarmEntry[] = [];
    for (const entry of list) {
      if (entry.expiresAt <= now) {
        expired.push(entry);
      } else {
        keep.push(entry);
      }
    }
    if (keep.length === 0) {
      s.byEnv.delete(envId);
    } else {
      s.byEnv.set(envId, keep);
    }
  }

  return expired;
}

/** Current number of warm entries for an environment. */
export function countWarm(envId: string): number {
  return state().byEnv.get(envId)?.length ?? 0;
}

/** In-progress replenishment count for an environment. */
export function countInflight(envId: string): number {
  return state().inflight.get(envId) ?? 0;
}

export function incrementInflight(envId: string): void {
  const s = state();
  s.inflight.set(envId, (s.inflight.get(envId) ?? 0) + 1);
}

export function decrementInflight(envId: string): void {
  const s = state();
  const cur = s.inflight.get(envId) ?? 0;
  const next = cur - 1;
  if (next <= 0) {
    s.inflight.delete(envId);
  } else {
    s.inflight.set(envId, next);
  }
}

/** Exposed for tests only. */
export function __resetWarmPool(): void {
  g.__caWarmPool = { byEnv: new Map(), inflight: new Map() };
}
