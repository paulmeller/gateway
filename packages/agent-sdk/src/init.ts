/**
 * One-time service initialization.
 *
 * Runs on first request (any route calls `await ensureInitialized()`):
 *   1. Boot the DB (which runs migrations)
 *   2. Recover stale sessions: any row with status='running' gets a
 *      `session.error{type:"server_restart"}` event + flipped to idle.
 *      (We do NOT implement true session.status_rescheduled semantics — see
 *      plan §I8.)
 *   3. Sprite orphan reconciler: best-effort pruning of old sprites whose
 *      sessions no longer exist.
 *
 * Pattern from 
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db/client";
import { createApiKey, listApiKeys } from "./db/api_keys";
import { getConfig } from "./config";
import { appendEvent } from "./sessions/bus";
import { getLastUnprocessedUserMessage } from "./db/events";
import { runSweep } from "./sessions/sweeper";
import { getRuntime } from "./state";
import { runTurn } from "./sessions/driver";
import { enqueueTurn } from "./queue";
import { reconcileOrphans, reconcileDockerOrphans } from "./containers/lifecycle";
import { installShutdownHandlers } from "./shutdown";
import { nowMs } from "./util/clock";
import { resolveContainerProvider } from "./providers/registry";
import { getEnvironment } from "./db/environments";
import { setSessionSprite } from "./db/sessions";
import * as pool from "./containers/pool";
import type { SessionRow } from "./types";

type GlobalInit = typeof globalThis & {
  __caInitPromise?: Promise<void>;
  __caSweeperHandle?: NodeJS.Timeout;
};
const g = globalThis as GlobalInit;

export async function ensureInitialized(): Promise<void> {
  if (g.__caInitPromise) return g.__caInitPromise;
  g.__caInitPromise = doInit();
  return g.__caInitPromise;
}

async function doInit(): Promise<void> {
  // 1. Bootstrap DB + migrations
  getDb();

  // 1b. Auto-seed a default API key if none exist
  seedDefaultApiKey();

  // 1c. Shutdown handlers
  installShutdownHandlers();

  // 2. Stale-session recovery
  try {
    await recoverStaleSessions();
  } catch (err) {
    console.error("[init] stale session recovery failed:", err);
  }

  // 3. Sprite orphan reconcile (best-effort, non-blocking)
  const cfg = getConfig();
  if (cfg.spriteToken) {
    reconcileOrphans()
      .then((r) => {
        if (r.deleted > 0) {
          console.log(`[init] reconciled ${r.deleted} orphan sprites, kept ${r.kept}`);
        }
      })
      .catch((err) => {
        console.warn("[init] orphan reconcile (sprites) failed:", err);
      });
  }

  // 3b. Docker orphan reconcile (best-effort, non-blocking)
  reconcileDockerOrphans()
    .then((r) => {
      if (r.deleted > 0) {
        console.log(`[init] reconciled ${r.deleted} orphan docker containers, kept ${r.kept}`);
      }
    })
    .catch((err) => {
      console.warn("[init] orphan reconcile (docker) failed:", err);
    });

  // 4. Install the periodic sweeper (idle eviction + orphan reconcile).
  // HMR caveat: the globalThis guard prevents duplicate timers across dev
  // reloads, but when `next dev` hot-reloads the sweeper module the existing
  // timer keeps firing into the *old* module's closure. Sweeper logic changes
  // in dev require a full server restart to pick up.
  if (!g.__caSweeperHandle) {
    const intervalMs = getConfig().sweeperIntervalMs;
    g.__caSweeperHandle = setInterval(() => {
      void runSweep();
    }, intervalMs);
  }
}

function seedDefaultApiKey(): void {
  try {
    const keys = listApiKeys();
    if (keys.length > 0) return;

    // If SEED_API_KEY is set (e.g. via Secret Manager in Cloud Run),
    // use it instead of generating a random key.
    const seedKey = process.env.SEED_API_KEY;
    if (seedKey) {
      const { id } = createApiKey({ name: "default", permissions: ["*"], rawKey: seedKey });
      console.log(`[init] created API key from SEED_API_KEY (id: ${id})`);
      return;
    }

    const { key, id } = createApiKey({ name: "default", permissions: ["*"] });

    // Write the key to .env so it survives restarts and isn't lost
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, `SEED_API_KEY=${key}\n`, "utf-8");
      console.log(`[init] created default API key and wrote to ${envPath}`);
    } else {
      // .env exists but had no SEED_API_KEY — append it
      fs.appendFileSync(envPath, `\nSEED_API_KEY=${key}\n`, "utf-8");
      console.log(`[init] created default API key and appended to ${envPath}`);
    }
    // Also set in process.env so CLI can pick it up immediately
    process.env.SEED_API_KEY = key;
    console.log(`  id:  ${id}`);
    console.log(`  key: ${key}`);
  } catch (err) {
    console.error("[init] failed to seed default API key:", err);
  }
}

export async function recoverStaleSessions(): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM sessions WHERE status = 'running' AND archived_at IS NULL`,
    )
    .all() as SessionRow[];

  if (rows.length === 0) return;
  console.log(`[init] recovering ${rows.length} stale running session(s)`);

  const rt = getRuntime();
  for (const row of rows) {
    try {
      // Try to reschedule: find the last unprocessed user.message
      const lastMsg = getLastUnprocessedUserMessage(row.id);
      if (lastMsg) {
        // If the session had a sprite, verify the container still exists
        if (row.sprite_name) {
          const envObj = getEnvironment(row.environment_id);
          const provider = await resolveContainerProvider(envObj?.config?.provider);
          try {
            const containers = await provider.list({ prefix: row.sprite_name });
            const alive = containers.some((c) => c.name === row.sprite_name);
            if (!alive) {
              console.warn(`[init] sprite ${row.sprite_name} for session ${row.id} no longer exists, clearing`);
              setSessionSprite(row.id, null);
            } else {
              // Re-register in the in-memory pool so lifecycle/sweeper can see it
              pool.register({
                spriteName: row.sprite_name,
                envId: row.environment_id,
                sessionId: row.id,
                createdAt: nowMs(),
              });
            }
          } catch (err) {
            console.warn(`[init] container health check failed for ${row.sprite_name}, clearing:`, err);
            setSessionSprite(row.id, null);
          }
        }

        // Emit rescheduled event
        appendEvent(row.id, {
          type: "session.status_rescheduled",
          payload: {},
          origin: "server",
          processedAt: nowMs(),
        });

        // Flip status to idle so the turn can restart
        db.prepare(
          `UPDATE sessions SET status = 'idle', stop_reason = 'rescheduled', updated_at = ? WHERE id = ?`,
        ).run(nowMs(), row.id);
        rt.inFlightRuns.delete(row.id);

        // Extract the text from the user.message payload
        const payload = JSON.parse(lastMsg.payload_json) as { content?: Array<{ type: string; text?: string }> };
        const text = (payload.content ?? [])
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text!)
          .join("");

        // Fire-and-forget: re-enqueue the turn
        void enqueueTurn(row.environment_id, () =>
          runTurn(row.id, [{ kind: "text", eventId: lastMsg.id, text }]),
        ).catch((err: unknown) => {
          console.error(`[init] reschedule turn failed for ${row.id}:`, err);
        });

        console.log(`[init] rescheduled session ${row.id}`);
        continue;
      }
    } catch (err) {
      console.warn(`[init] reschedule attempt failed for ${row.id}, falling back to error:`, err);
    }

    // Fallback: emit error + idle
    try {
      appendEvent(row.id, {
        type: "session.error",
        payload: {
          error: {
            type: "server_restart",
            message: "server restarted while turn was running",
          },
        },
        origin: "server",
        processedAt: nowMs(),
      });
      appendEvent(row.id, {
        type: "session.status_idle",
        payload: { stop_reason: "error" },
        origin: "server",
        processedAt: nowMs(),
      });
      db.prepare(
        `UPDATE sessions SET status = 'idle', stop_reason = 'error', updated_at = ? WHERE id = ?`,
      ).run(nowMs(), row.id);
      rt.inFlightRuns.delete(row.id);
    } catch (err) {
      console.error(`[init] failed to recover session ${row.id}:`, err);
    }
  }
}
