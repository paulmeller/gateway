/**
 * Sentry error tracking — server-side.
 *
 * Initializes once on first import. Reads DSN from SENTRY_DSN env var.
 * No-op if SENTRY_DSN is not set.
 */

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  initialized = true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  try {
    // Dynamic import to avoid bundling Sentry when not used
    import("@sentry/node").then((Sentry) => {
      Sentry.init({
        dsn,
        environment: process.env.NODE_ENV || "production",
        release: process.env.GATEWAY_VERSION || "dev",
        tracesSampleRate: 0.1,
        // Don't send PII
        sendDefaultPii: false,
      });
      console.log("[sentry] initialized");
    }).catch(() => {
      // Sentry not installed — ignore
    });
  } catch {
    // ignore
  }
}

export function captureException(err: unknown): void {
  try {
    import("@sentry/node").then((Sentry) => {
      Sentry.captureException(err);
    }).catch(() => {});
  } catch {
    // ignore
  }
}
