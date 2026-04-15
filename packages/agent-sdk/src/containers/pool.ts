/**
 * Per-environment sprite pool + session-to-sprite affinity.
 *
 * Sessions are pinned 1:1 to a sprite for their entire lifetime. The pool
 * tracks which sprites are attached to which sessions so we can enforce
 * `max_sprites_per_env` and clean up on session delete.
 *
 * Pattern inspired by
 * 
 */
export interface SpriteEntry {
  spriteName: string;
  envId: string;
  sessionId: string;
  createdAt: number;
  /** Vault secrets resolved at container creation time, passed to provider methods. */
  vaultSecrets?: Record<string, string>;
}

type PoolState = {
  byEnv: Map<string, SpriteEntry[]>;
  bySession: Map<string, SpriteEntry>;
};

type GlobalPool = typeof globalThis & { __caPool?: PoolState };
const g = globalThis as GlobalPool;

function state(): PoolState {
  if (!g.__caPool) {
    g.__caPool = { byEnv: new Map(), bySession: new Map() };
  }
  return g.__caPool;
}

export function register(entry: SpriteEntry): void {
  const s = state();
  const list = s.byEnv.get(entry.envId) ?? [];
  list.push(entry);
  s.byEnv.set(entry.envId, list);
  s.bySession.set(entry.sessionId, entry);
}

export function getBySession(sessionId: string): SpriteEntry | null {
  return state().bySession.get(sessionId) ?? null;
}

export function countInEnv(envId: string): number {
  return state().byEnv.get(envId)?.length ?? 0;
}

export function unregister(sessionId: string): SpriteEntry | null {
  const s = state();
  const entry = s.bySession.get(sessionId);
  if (!entry) return null;
  s.bySession.delete(sessionId);
  const list = s.byEnv.get(entry.envId);
  if (list) {
    const idx = list.findIndex((e) => e.sessionId === sessionId);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) s.byEnv.delete(entry.envId);
  }
  return entry;
}

export function allSessionSprites(): SpriteEntry[] {
  return Array.from(state().bySession.values());
}
