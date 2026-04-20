/**
 * Graceful shutdown on SIGTERM and SIGINT.
 *
 * Aborts all in-flight turn controllers, gives them up to 5s to emit their
 * `session.status_idle{stop_reason:"interrupted"}` via the driver's normal
 * abort path, then exits. Sessions that don't finish in time will be picked
 * up by the next startup's stale-recovery path.
 */
import { getRuntime } from "./state";
import { markStopping } from "./sessions/sweeper";
import { syncDb, closeDb } from "./db/client";

type GlobalShutdown = typeof globalThis & {
  __caShutdownInstalled?: boolean;
  __caSweeperHandle?: NodeJS.Timeout;
};
const g = globalThis as GlobalShutdown;

export function installShutdownHandlers(): void {
  if (g.__caShutdownInstalled) return;
  g.__caShutdownInstalled = true;

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    // Second signal — force exit immediately
    console.log(`[shutdown] forced exit`);
    process.exit(1);
  }
  shuttingDown = true;

  const rt = getRuntime();
  const inflight = rt.inFlightRuns.size;

  if (inflight > 0) {
    console.log(`[shutdown] stopping ${inflight} in-flight turn${inflight > 1 ? "s" : ""}...`);
  } else {
    console.log(`[shutdown] shutting down...`);
  }

  // Tell the sweeper to stop starting new eviction work, then clear the
  // interval. Any in-progress sweep finishes its current candidate and bails.
  markStopping();
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle);
    g.__caSweeperHandle = undefined;
  }

  for (const run of rt.inFlightRuns.values()) {
    try {
      run.controller.abort(new DOMException("shutting down", "AbortError"));
    } catch {
      /* ignore */
    }
  }

  // Give drivers a moment to append their idle-interrupted events
  if (inflight > 0) {
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Sync embedded replica to Turso and close the DB cleanly
  syncDb();
  closeDb();

  process.exit(0);
}
