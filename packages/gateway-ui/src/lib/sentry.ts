import * as Sentry from "@sentry/react";

declare global {
  interface Window {
    __MA_SENTRY_DSN__?: string;
  }
}

export function initSentry(): void {
  const dsn = window.__MA_SENTRY_DSN__;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: window.location.hostname === "localhost" ? "development" : "production",
    release: window.__MA_VERSION__ || "dev",
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0.1,
  });
}

export { Sentry };
