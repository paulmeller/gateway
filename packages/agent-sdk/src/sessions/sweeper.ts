/**
 * Periodic sweeper: idle eviction + orphan reconcile.
 *
 * One unified sweeper with one `setInterval`, installed in `lib/init.ts`.
 * One timer means one set of interleaving concerns.
 *
 * Park/restore as originally planned is infeasible (spike S2: sprites.dev
 * checkpoints are per-sandbox only; no stopSprite API). The correct M5
 * model is: pin the sandbox for the session's lifetime, and evict the
 * session (release the sandbox, terminate the row) after idle TTL expires.
 *
 * Re-entrancy: `sweeping` prevents overlapping ticks from stacking if a
 * prior sweep runs longer than the interval. A stuck `releaseSession` can
 * take up to `spriteTimeoutMs` (30s default) per candidate, so a bad run
 * with 50 candidates could exceed the 60s interval.
 *
 * Shutdown cooperation: `stopping` is set by the shutdown handler so the
 * sweep bails out cleanly between candidates if SIGTERM fires mid-run.
 */
import { getConfig } from "../config";
import { nowMs } from "../util/clock";
import { getRuntime } from "../state";
import { getActor, dropActor } from "./actor";
import { appendEvent, dropEmitter } from "./bus";
import {
  archiveSession,
  getSessionRow,
  listIdleSessions,
  updateSessionStatus,
} from "../db/sessions";
import { releaseSession, reconcileOrphanSandboxes, reconcileDockerOrphanSandboxes } from "../containers/lifecycle";
import { expireWarm } from "../containers/warm-pool";
import { resolveContainerProvider } from "../providers/registry";
import { getEnvironment } from "../db/environments";

let sweeping = false;
let stopping = false;

export function markStopping(): void {
  stopping = true;
}

/** Exposed for tests only. */
export function __resetSweeperState(): void {
  sweeping = false;
  stopping = false;
}

export async function runSweep(): Promise<void> {
  if (sweeping || stopping) return;
  sweeping = true;
  try {
    try {
      await evictIdleSessions();
    } catch (e) {
      console.warn("[sweeper] evict failed:", e);
    }
    const cfg = getConfig();
    if (cfg.spriteToken) {
      try {
        await reconcileOrphanSandboxes();
      } catch (e) {
        console.warn("[sweeper] reconcile sandboxes failed:", e);
      }
    }
    try {
      await reconcileDockerOrphanSandboxes();
    } catch (e) {
      // Docker not available — skip silently
      if (!(e instanceof Error) || !e.message.includes("ENOENT")) {
        console.warn("[sweeper] reconcile docker failed:", e);
      }
    }
    try {
      await evictExpiredWarmContainers();
    } catch (e) {
      console.warn("[sweeper] warm pool eviction failed:", e);
    }
  } finally {
    sweeping = false;
  }
}

/**
 * Evict warm containers that have passed their TTL.
 * Calls `provider.delete` on each expired entry and logs the eviction.
 */
async function evictExpiredWarmContainers(): Promise<void> {
  const expired = expireWarm(nowMs());
  if (expired.length === 0) return;

  console.log(`[sweeper] evicting ${expired.length} expired warm container(s)`);

  for (const entry of expired) {
    try {
      const envObj = getEnvironment(entry.envId);
      const provider = await resolveContainerProvider(envObj?.config?.provider);
      await provider.delete(entry.sandboxName, entry.vaultSecrets);
      console.log(`[sweeper] deleted expired warm container: ${entry.sandboxName}`);
    } catch (err) {
      console.warn(`[sweeper] failed to delete warm container ${entry.sandboxName}:`, err);
    }
  }
}

async function evictIdleSessions(): Promise<void> {
  if (stopping) return;
  const cfg = getConfig();
  const now = nowMs();

  // COALESCE so sessions that never ran a turn (idle_since IS NULL) still
  // age out from their created_at. LIMIT caps the worst case per sweep.
  const rows = listIdleSessions(cfg.sessionMaxAgeMs, now, 50);

  if (rows.length === 0) return;

  for (const { id: sessionId } of rows) {
    if (stopping) return;
    try {
      await getActor(sessionId).enqueue(async () => {
        // CRITICAL: runTurn executes OUTSIDE the actor lock (see
        // app/v1/sessions/[id]/events/route.ts — enqueueTurn launches runTurn
        // after releasing the actor). Checking session.status in the DB is
        // not enough — it may still be "idle" for a few ms after a fresh
        // POST /events fired off a new turn. The in-memory inFlightRuns map
        // is the authoritative "turn in progress" signal.
        const rt = getRuntime();
        if (rt.inFlightRuns.has(sessionId)) return;

        const row = getSessionRow(sessionId);
        if (!row || row.status !== "idle" || row.archived_at != null) return;

        // Re-check the TTL inside the lock — if another code path already
        // bumped idle_since forward (turn completed), bail.
        const base = row.idle_since ?? row.created_at;
        if (base + cfg.sessionMaxAgeMs >= now) return;

        await releaseSession(sessionId);

        appendEvent(sessionId, {
          type: "session.status_terminated",
          payload: { reason: "idle_ttl" },
          origin: "server",
          processedAt: nowMs(),
        });
        updateSessionStatus(sessionId, "terminated", "idle_ttl");
        archiveSession(sessionId);
      });
      dropActor(sessionId);
      dropEmitter(sessionId);
    } catch (err) {
      // Per-candidate isolation: one stuck session must not block the rest
      // of the sweep. `releaseSession` is already best-effort internally,
      // so this catch mainly protects against appendEvent/DB failures.
      console.warn(`[sweeper] evict ${sessionId} failed:`, err);
    }
  }
}
