/**
 * Fixed-window rate limiter, keyed by API key id.
 *
 * Two backends, selected via `RATE_LIMIT_BACKEND`:
 *   - `memory` (default) — per-process Map. Single-host only; a
 *     clustered deployment (N `gateway serve` workers behind a proxy)
 *     ends up with an effective limit of `limit × N` per key.
 *   - `redis` — shared fixed-window counter. Uses `INCR` + `PEXPIRE` on
 *     a bucket key that rotates every 60s. Atomic across processes and
 *     hosts. Requires `REDIS_URL`; `ioredis` is dynamic-imported so the
 *     dependency is only loaded when you actually opt in.
 *
 * Fixed window (not sliding or token bucket) — over-allows at boundaries
 * by up to 2×, but is trivial to reason about and removes the need for
 * sample buffers. Good enough for ops-level limits.
 */

interface Bucket {
  /** First ms of the current window. */
  windowStart: number;
  /** Count of requests observed in the current window. */
  count: number;
}

/** HMR-safe singleton on globalThis so dev server reloads don't lose counters. */
type GlobalBucketStore = typeof globalThis & {
  __caRateLimitBuckets?: Map<string, Bucket>;
  __caRateLimitRedis?: RedisClientLike | "unavailable" | undefined;
};
const g = globalThis as GlobalBucketStore;
if (!g.__caRateLimitBuckets) g.__caRateLimitBuckets = new Map();
const buckets = g.__caRateLimitBuckets;

const WINDOW_MS = 60_000;

// ── Memory backend ────────────────────────────────────────────────────

function memoryCheckAndBump(keyId: string, limitPerMinute: number): number | null {
  const now = Date.now();
  let b = buckets.get(keyId);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    // New window
    b = { windowStart: now, count: 1 };
    buckets.set(keyId, b);
    return null;
  }
  if (b.count >= limitPerMinute) {
    const retryAfterMs = WINDOW_MS - (now - b.windowStart);
    return Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
  b.count++;
  return null;
}

// ── Redis backend ─────────────────────────────────────────────────────
//
// `ioredis` is optional — only loaded when RATE_LIMIT_BACKEND=redis. If
// the module isn't installed we degrade to memory and log a one-time
// warning, rather than crashing the server. That keeps the defaults
// frictionless for single-host installs.

interface RedisClientLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  quit?(): Promise<unknown>;
}

let redisLoadPromise: Promise<RedisClientLike | "unavailable"> | null = null;

/**
 * Are we allowed to silently fall back to memory when the Redis
 * backend can't be loaded? Two policies:
 *
 *   - strict (default): any of (a) ioredis not installed, (b) REDIS_URL
 *     unset throws at *first use* of `checkAndBump`. Failing loud
 *     prevents the "N replicas silently enforce limit × N" footgun
 *     where ops believe they've deployed a shared limiter but haven't.
 *   - lenient: set RATE_LIMIT_BACKEND_ALLOW_FALLBACK=true. Fall back
 *     to memory with a warning. Intended for single-host installs
 *     that opted into redis in a template and don't want to block
 *     boot when Redis isn't there.
 *
 * Note: transient Redis errors *at request time* always fail open to
 * memory (handled in redisCheckAndBump). The strict/lenient toggle
 * only covers the load-time "ioredis missing" / "REDIS_URL missing"
 * case.
 */
function allowFallback(): boolean {
  const v = (process.env.RATE_LIMIT_BACKEND_ALLOW_FALLBACK ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function loadRedis(): Promise<RedisClientLike | "unavailable"> {
  if (g.__caRateLimitRedis != null) return g.__caRateLimitRedis;
  if (redisLoadPromise) return redisLoadPromise;
  redisLoadPromise = (async () => {
    const url = process.env.REDIS_URL;
    if (!url) {
      const msg = "[rate_limit] RATE_LIMIT_BACKEND=redis but REDIS_URL is unset.";
      if (allowFallback()) {
        console.warn(`${msg} Falling back to memory (RATE_LIMIT_BACKEND_ALLOW_FALLBACK=true).`);
        g.__caRateLimitRedis = "unavailable";
        return "unavailable";
      }
      // Strict default: fail the first rate-limit call so that a
      // mis-configured cluster surface this *now*, not after days of
      // silent over-allowance.
      throw new Error(
        `${msg} Set REDIS_URL or opt into the memory fallback with ` +
        `RATE_LIMIT_BACKEND_ALLOW_FALLBACK=true.`,
      );
    }

    try {
      // ioredis default export is the `Redis` class. Using `new` with
      // the URL gives a lazily-connected client — the first operation
      // establishes the socket, so we don't block startup.
      const mod = await import("ioredis" as string);
      const Ctor = (mod.default ?? mod.Redis) as new (url: string) => RedisClientLike;
      const client = new Ctor(url);
      // ioredis emits 'error' on connection failures, auth rejections,
      // etc. Without a listener Node's default is to throw an unhandled
      // exception that can crash the process. Attach a drain so we just
      // log — the per-request try/catch in redisCheckAndBump handles
      // the actual fallback to memory.
      const asEmitter = client as unknown as { on?: (evt: string, fn: (err: unknown) => void) => void };
      if (typeof asEmitter.on === "function") {
        asEmitter.on("error", (err: unknown) => {
          console.warn("[rate_limit] redis client error:", err);
        });
      }
      g.__caRateLimitRedis = client;
      return client;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const msg =
        "[rate_limit] RATE_LIMIT_BACKEND=redis but ioredis isn't installed. " +
        "Run `npm i ioredis` in the deployment image.";
      if (allowFallback()) {
        console.warn(`${msg} Falling back to memory (RATE_LIMIT_BACKEND_ALLOW_FALLBACK=true). detail=${detail}`);
        g.__caRateLimitRedis = "unavailable";
        return "unavailable";
      }
      throw new Error(`${msg} detail=${detail}`);
    }
  })();
  return redisLoadPromise;
}

/**
 * Atomic fixed-window increment on Redis. The bucket key includes the
 * window start so concurrent minutes never contend on the same key —
 * and `PEXPIRE` guarantees stale windows get reaped without a sweeper.
 */
async function redisCheckAndBump(
  client: RedisClientLike,
  keyId: string,
  limitPerMinute: number,
): Promise<number | null> {
  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const bucketKey = `as:rl:${keyId}:${windowStart}`;
  try {
    const count = await client.incr(bucketKey);
    if (count === 1) {
      // Fresh bucket — set TTL so we don't accumulate dead keys.
      await client.pexpire(bucketKey, WINDOW_MS + 1000);
    }
    if (count > limitPerMinute) {
      const retryAfterMs = windowStart + WINDOW_MS - now;
      return Math.max(1, Math.ceil(retryAfterMs / 1000));
    }
    return null;
  } catch (err) {
    // Redis outage → fail open to memory. Safer than dropping all
    // requests because the rate-limiter is down. Also matches
    // docker-compose environments where Redis takes a moment to come up.
    console.warn("[rate_limit] redis error, falling back to memory for this request:", err);
    return memoryCheckAndBump(keyId, limitPerMinute);
  }
}

// ── Public API ────────────────────────────────────────────────────────

function getBackend(): "memory" | "redis" {
  const v = (process.env.RATE_LIMIT_BACKEND ?? "memory").toLowerCase();
  return v === "redis" ? "redis" : "memory";
}

/**
 * Check-and-bump: returns `null` if the request is allowed, or a
 * non-negative integer (seconds until the next window starts) if
 * refused.
 *
 * `limitPerMinute === null` → unlimited (always returns null).
 *
 * Async so the Redis backend can actually call the network. The memory
 * backend completes synchronously and Promise.resolve()s immediately,
 * so routeWrap pays at most one microtask on the hot path.
 */
export async function checkAndBump(
  keyId: string,
  limitPerMinute: number | null,
): Promise<number | null> {
  if (limitPerMinute == null || limitPerMinute <= 0) return null;

  if (getBackend() === "redis") {
    // Redis backend requires enterprise license. Community tier gets
    // in-memory only. When ops sets RATE_LIMIT_BACKEND=redis without
    // a license, we silently degrade to memory (the boot-time
    // validateBackend check already ensures ioredis + REDIS_URL are
    // present; this is a separate "do you have the plan?" check).
    const { hasFeature } = await import("../license");
    if (!hasFeature("redis_rate_limit")) {
      return memoryCheckAndBump(keyId, limitPerMinute);
    }
    const client = await loadRedis();
    if (client !== "unavailable") {
      return redisCheckAndBump(client, keyId, limitPerMinute);
    }
    // Fall through to memory on unavailable.
  }
  return memoryCheckAndBump(keyId, limitPerMinute);
}

/** Test hook: clear all counters. No-op in production code paths. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** Test hook: inspect the counter for a key (or undefined if no window active). */
export function peekRateLimit(keyId: string): Bucket | undefined {
  return buckets.get(keyId);
}

/**
 * Boot-time preflight: eagerly resolve the Redis backend so misconfig
 * fails the init promise (and prevents the server from starting)
 * instead of 500-ing on the first request. Call from init.ts only.
 *
 * No-op when the backend isn't "redis".
 */
export async function validateBackend(): Promise<void> {
  if (getBackend() !== "redis") return;
  await loadRedis(); // throws on strict-fail
}

/** Test hook: override the resolved Redis client (or force "unavailable"). */
export function _setRedisClientForTesting(client: RedisClientLike | "unavailable" | undefined): void {
  g.__caRateLimitRedis = client;
  redisLoadPromise = null;
}
