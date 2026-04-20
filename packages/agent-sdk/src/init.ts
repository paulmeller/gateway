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
 */
import fs from "node:fs";
import path from "node:path";
import { readEnvValue, upsertEnvLine } from "./util/env";
import { getDb } from "./db/client";
import { createApiKey, listApiKeys } from "./db/api_keys";
import { getConfig } from "./config";
import { appendEvent, installPayloadRedactor } from "./sessions/bus";
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
import { initSentry } from "./sentry";
import { setSessionSprite } from "./db/sessions";
import * as pool from "./containers/pool";
import { installOtlpExporter } from "./observability/otlp";
import { redactAppendInput } from "./observability/redactor";
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
  // 0. Sentry (no-op if SENTRY_DSN not set)
  initSentry();

  // 1. Bootstrap DB + migrations
  getDb();

  // 1a. Seed the `default` tenant row (v0.5+). Idempotent — does nothing
  // if the row is already there.
  const { seedDefaultTenant } = await import("./db/tenants");
  seedDefaultTenant();

  // 1a½. Boot-time .env health check — warn about duplicate keys.
  try {
    const { findDuplicateKeys } = await import("./util/env");
    const envPath = path.resolve(process.cwd(), ".env");
    const dupes = findDuplicateKeys(envPath);
    if (dupes.length > 0) {
      console.warn(
        `[init] WARNING: duplicate keys in .env: ${dupes.join(", ")}. ` +
        `dotenv uses the LAST value — earlier entries are silently ignored. ` +
        `Remove duplicates to prevent confusion.`,
      );
    }
  } catch { /* non-fatal */ }

  // 1b. Auto-seed a default API key if none exist
  seedDefaultApiKey();

  // 1c. Observability: install the bus-level payload redactor and the
  // OTLP auto-export hook. The redactor is always installed (no-op when
  // there are no secrets to scrub); the OTLP exporter fires only when
  // an endpoint is configured.
  installPayloadRedactor(redactAppendInput);
  installOtlpExporter();

  // 1c½. Anthropic file sync: when a proxied turn completes, fetch
  // the file list from Anthropic and cache metadata locally.
  const { installFileSyncHook } = await import("./sync/file-sync");
  installFileSyncHook();

  // 1d. Validate license key (community vs enterprise).
  const { validateLicense } = await import("./license");
  validateLicense();

  // 1e. Validate Redis rate-limit backend at boot. When
  // RATE_LIMIT_BACKEND=redis and ioredis/REDIS_URL aren't available,
  // we fail here so the process never starts serving — instead of the
  // previous behavior where /api/health stayed green and every /v1
  // request returned 500.
  await validateRateLimitBackend();

  // 1e. Shutdown handlers
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

    const envPath = path.resolve(process.cwd(), ".env");

    // Check process.env first, then read .env directly (dotenv may
    // not have loaded yet). This prevents generating a new key when
    // .env already has one — the root cause of the duplicate-line bug.
    let seedKey = process.env.SEED_API_KEY;
    if (!seedKey) {
      // readEnvValue imported at top of file
      seedKey = readEnvValue(envPath, "SEED_API_KEY");
      if (seedKey) process.env.SEED_API_KEY = seedKey;
    }

    if (seedKey) {
      const { id } = createApiKey({ name: "default", permissions: ["*"], rawKey: seedKey });
      console.log(`[init] created API key from SEED_API_KEY (id: ${id})`);
      return;
    }

    // Neither process.env nor .env has a seed key — generate one.
    const { key, id } = createApiKey({ name: "default", permissions: ["*"] });

    // Write to .env via upsert (safe: replaces if exists, appends if not,
    // never creates duplicates).
    // upsertEnvLine imported at top of file
    upsertEnvLine(envPath, "SEED_API_KEY", key);
    console.log(`[init] created default API key and wrote to ${envPath}`);

    process.env.SEED_API_KEY = key;
    console.log(`  id:  ${id}`);
    console.log(`  key: (written to .env — see SEED_API_KEY)`);
  } catch (err) {
    console.error("[init] failed to seed default API key:", err);
  }
}

/**
 * Pre-flight: when RATE_LIMIT_BACKEND=redis, verify that ioredis is
 * importable AND REDIS_URL is set *before* the first request arrives.
 * Without this, the gateway boots green (health check passes) while
 * every authenticated request 500s — the exact "looks healthy, isn't"
 * pattern ops hates.
 *
 * On success, warm-connects the Redis client. On failure: either
 * throws (boot fails) or degrades to memory when
 * RATE_LIMIT_BACKEND_ALLOW_FALLBACK=true.
 */
async function validateRateLimitBackend(): Promise<void> {
  const { validateBackend } = await import("./auth/rate_limit");
  // Throws when RATE_LIMIT_BACKEND=redis but ioredis or REDIS_URL
  // aren't available (strict default). The throw propagates out of
  // doInit → ensureInitialized, which makes the first routeWrap call
  // reject with a clear message. The server never serves a 200.
  await validateBackend();
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
        payload: { stop_reason: { type: "error" } },
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
