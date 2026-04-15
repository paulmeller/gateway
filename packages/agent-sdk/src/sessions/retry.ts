/**
 * Turn retry logic.
 *
 * Only stream/exec errors retry — container creation and buildTurn failures
 * are terminal. Max 3 retries per turn with exponential backoff + jitter.
 *
 * Backoff schedule:
 *   Rate limited:  5s → 15s → 45s
 *   Overloaded:    2s →  6s → 18s
 *   Other:         no retry (terminal)
 *
 * Jitter: ±20% on each delay.
 */
import type { ClassifiedError } from "./errors";

const MAX_RETRIES = 3;

const BASE_DELAYS: Record<string, number> = {
  model_rate_limited_error: 5000,
  model_overloaded_error: 2000,
};

/** In-memory retry counters per session. Reset on success or server restart. */
const retryCounts = new Map<string, number>();

export function getRetryCount(sessionId: string): number {
  return retryCounts.get(sessionId) ?? 0;
}

export function incrementRetry(sessionId: string): number {
  const count = getRetryCount(sessionId) + 1;
  retryCounts.set(sessionId, count);
  return count;
}

export function resetRetry(sessionId: string): void {
  retryCounts.delete(sessionId);
}

/**
 * Determine if and how long to wait before retrying.
 * Returns null if the error is not retryable or max retries exceeded.
 */
export function shouldRetry(
  sessionId: string,
  classified: ClassifiedError,
): { delayMs: number; attempt: number } | null {
  if (!classified.retryable) return null;

  const count = getRetryCount(sessionId);
  if (count >= MAX_RETRIES) return null;

  const baseDelay = BASE_DELAYS[classified.type] ?? 5000;
  const multiplier = Math.pow(3, count); // 1, 3, 9
  const delay = baseDelay * multiplier;

  // Jitter: ±20%
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  const delayMs = Math.round(delay + jitter);

  return { delayMs, attempt: count + 1 };
}

/**
 * Wait for the specified delay. Returns a promise that resolves after delayMs.
 */
export function retryDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
