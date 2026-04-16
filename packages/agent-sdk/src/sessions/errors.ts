/**
 * Session error classification.
 *
 * Maps raw error messages from backends, providers, and the driver into
 * structured error types matching the Anthropic Managed Agents API taxonomy.
 *
 * Error types:
 *   model_overloaded_error   — provider temporarily overloaded
 *   model_rate_limited_error — rate limit hit
 *   model_request_failed_error — model returned an error response
 *   billing_error            — insufficient credits / quota
 *   server_error             — internal gateway error
 *   unknown_error            — unclassifiable
 *
 * Retry status:
 *   retrying  — the gateway will auto-retry this turn
 *   exhausted — max retries reached, giving up
 *   terminal  — not retryable (billing, config, etc.)
 */

export type SessionErrorType =
  | "model_overloaded_error"
  | "model_rate_limited_error"
  | "model_request_failed_error"
  | "billing_error"
  | "server_error"
  | "unknown_error";

export type RetryStatus = "retrying" | "exhausted" | "terminal";

export interface ClassifiedError {
  type: SessionErrorType;
  retryable: boolean;
  message: string;
}

const RATE_LIMIT_PATTERNS = [
  "rate_limit",
  "rate limit",
  "429",
  "too many requests",
  "model_rate_limited",
];

const OVERLOADED_PATTERNS = [
  "overloaded",
  "capacity",
  "503",
  "service unavailable",
  "model_overloaded",
];

const BILLING_PATTERNS = [
  "credit balance",
  "billing",
  "insufficient",
  "quota",
  "payment",
  "billing_error",
  "purchase credits",
];

const REQUEST_FAILED_PATTERNS = [
  "invalid_request",
  "authentication_failed",
  "invalid_api_key",
  "unauthorized",
  "403",
  "401",
];

export function classifyError(message: string): ClassifiedError {
  const lower = message.toLowerCase();

  for (const p of RATE_LIMIT_PATTERNS) {
    if (lower.includes(p)) {
      return { type: "model_rate_limited_error", retryable: true, message };
    }
  }

  for (const p of OVERLOADED_PATTERNS) {
    if (lower.includes(p)) {
      return { type: "model_overloaded_error", retryable: true, message };
    }
  }

  for (const p of BILLING_PATTERNS) {
    if (lower.includes(p)) {
      return { type: "billing_error", retryable: false, message };
    }
  }

  for (const p of REQUEST_FAILED_PATTERNS) {
    if (lower.includes(p)) {
      return { type: "model_request_failed_error", retryable: false, message };
    }
  }

  // Default: server_error, not retryable (safe default)
  return { type: "server_error", retryable: false, message };
}

/**
 * Build a structured session.error payload.
 */
export function buildErrorPayload(
  classified: ClassifiedError,
  retryStatus: RetryStatus,
): { error: { type: SessionErrorType; message: string; retry_status: RetryStatus } } {
  return {
    error: {
      type: classified.type,
      message: classified.message,
      retry_status: retryStatus,
    },
  };
}
