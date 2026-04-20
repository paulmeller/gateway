/**
 * Webhook payload signing + verification — v0.5 PR4a.
 *
 * Outbound: packages/agent-sdk/src/sessions/bus.ts signs every webhook
 * body with HMAC-SHA256 when the agent has a `webhook_secret` configured.
 *
 * Inbound (receivers): use `verifyWebhookSignature({ secret, headers,
 * body })` to confirm the request came from this gateway and hasn't
 * been replayed outside a short time window.
 *
 * Header contract:
 *   X-AgentStep-Timestamp: <unix_ms>
 *   X-AgentStep-Signature: sha256=<hex(hmac_sha256(secret, `${ts}.${body}`))>
 *
 * The timestamp is inside the MAC so it can't be swapped after capture.
 * Receivers should reject timestamps outside ±5 minutes (configurable
 * via `toleranceMs`) to blunt replay attacks even when the MAC is valid.
 */
import crypto from "node:crypto";

export const SIGNATURE_HEADER = "X-AgentStep-Signature";
export const TIMESTAMP_HEADER = "X-AgentStep-Timestamp";

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000; // ±5 minutes

export interface VerifyInput {
  /** The agent's shared secret. */
  secret: string;
  /** Raw request body bytes as a UTF-8 string. */
  body: string;
  /** Case-insensitive header lookup function, OR a plain Headers object. */
  headers: Headers | Record<string, string | null | undefined>;
  /** Replay-protection window in milliseconds. Default ±5min. */
  toleranceMs?: number;
  /** Override "now" for deterministic tests. Default `Date.now()`. */
  nowMs?: number;
}

export type VerifyResult =
  | { ok: true; timestampMs: number }
  | { ok: false; reason: string };

function headerVal(
  headers: VerifyInput["headers"],
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  // Plain-object lookup is case-insensitive.
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v ?? null;
  }
  return null;
}

/**
 * Compute the expected signature for a body + timestamp. Exposed so
 * outbound sign-and-send and verification can share one source of truth.
 */
export function computeSignature(secret: string, timestampMs: number, body: string): string {
  const h = crypto.createHmac("sha256", secret);
  h.update(`${timestampMs}.${body}`);
  return h.digest("hex");
}

/**
 * Verify an inbound webhook request. Returns `{ok: true}` only when
 * the signature matches AND the timestamp is within tolerance.
 *
 * Uses `crypto.timingSafeEqual` to prevent leaking the signature via
 * timing side-channels.
 */
export function verifyWebhookSignature(input: VerifyInput): VerifyResult {
  const sigHeader = headerVal(input.headers, SIGNATURE_HEADER);
  const tsHeader  = headerVal(input.headers, TIMESTAMP_HEADER);
  if (!sigHeader) return { ok: false, reason: "missing signature header" };
  if (!tsHeader)  return { ok: false, reason: "missing timestamp header" };

  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid timestamp" };

  const now = input.nowMs ?? Date.now();
  const tolerance = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  if (Math.abs(now - ts) > tolerance) {
    return { ok: false, reason: "timestamp outside tolerance window" };
  }

  // Expected: "sha256=<hex>". Accept missing prefix for forward-compat.
  const provided = sigHeader.startsWith("sha256=") ? sigHeader.slice(7) : sigHeader;
  const expected = computeSignature(input.secret, ts, input.body);

  // Constant-time compare. Both strings must share length before
  // timingSafeEqual accepts them; a mismatched length is a bogus sig.
  if (provided.length !== expected.length) {
    return { ok: false, reason: "signature length mismatch" };
  }
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) {
    return { ok: false, reason: "signature decode mismatch" };
  }
  if (!crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true, timestampMs: ts };
}
