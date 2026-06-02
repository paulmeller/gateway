/**
 * Debug-prompt capture: surface the assembled prompt that the gateway
 * sent to the backend CLI on a session's first turn.
 *
 * Use case (from a customer ticket, 2026-05): when a Claude session
 * silently stops mid-turn, the only way to triangulate which prompt
 * shape triggered the gate is to compare the inputs to a working
 * session and a failing session. Until now this required reading
 * server logs. With `?debug=prompt` (or `X-AgentStep-Debug: prompt`),
 * the captured payload lives on the session row and is API-accessible
 * for 1 hour.
 *
 * Lifecycle:
 *   1. POST /v1/sessions with the flag → row created with sentinel
 *      `debug_prompt_json = '{"pending":true}'`.
 *   2. First turn → driver overwrites with `{captured_at, argv,
 *      env (redacted), prompt, system, ...}` (see CapturedPrompt).
 *   3. GET /v1/sessions/:id/debug-prompt → returns the payload, or
 *      410 Gone if captured_at is older than 1 hour, or 404 if the
 *      flag was not set or no turn has run.
 */
import { routeWrap } from "../http";
import { notFound, badRequest } from "../errors";
import { getSessionRow } from "../db/sessions";
import { assertResourceTenant } from "../auth/scope";
import { nowMs, toIso } from "../util/clock";

/**
 * Request triggers — either header or query param. Header is preferred
 * for CI/CLI debugging since it doesn't change the URL. The header
 * value must be `prompt` (forward-compatible: future shapes like
 * `tokens`, `events` can join the same header).
 */
export function isDebugPromptRequested(request: Request): boolean {
  const header = request.headers.get("x-agentstep-debug");
  if (header && header.trim().toLowerCase() === "prompt") return true;
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get("debug");
    if (q && q.toLowerCase() === "prompt") return true;
  } catch { /* malformed URL — fall through */ }
  return false;
}

/**
 * Env-var keys that almost certainly hold secrets. We redact these
 * before persisting. The list is conservative; missed keys leak a
 * value into the debug-prompt JSON, which is server-side but still
 * shouldn't carry credentials.
 *
 * Pattern in addition to the explicit set: anything ending in
 * `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD` (case-insensitive).
 */
const SECRET_KEY_RE = /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;
const KNOWN_SECRET_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "CODEX_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GOOGLE_API_KEY",
  "AGENTSTEP_LICENSE_KEY",
  // Opencode bakes its config (which may contain provider keys) into
  // this env var as a JSON blob. Redact wholesale rather than try to
  // parse + scrub.
  "OPENCODE_CONFIG_CONTENT",
]);

export function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (KNOWN_SECRET_KEYS.has(k) || SECRET_KEY_RE.test(k)) {
      out[k] = `<redacted:len=${v.length}>`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface CapturedPrompt {
  captured_at: string;
  backend: string;
  model: string;
  /** Full argv passed to the backend wrapper script. */
  argv: string[];
  /** Env vars that wrap-script reads before exec, with secrets redacted. */
  env: Record<string, string>;
  /** The user-message body the backend will hand to the CLI's stdin. */
  prompt: string;
  /** Agent's system prompt at turn time (may be null if unset). */
  system: string | null;
}

/** How long captured payloads remain retrievable. */
const RETENTION_MS = 60 * 60 * 1000;

/**
 * GET /v1/sessions/:id/debug-prompt
 * Same tenant scoping as the session itself.
 */
export function handleGetDebugPrompt(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (!id) throw badRequest("session id required");
    const row = getSessionRow(id);
    if (!row) throw notFound(`session not found: ${id}`);
    assertResourceTenant(auth, row.tenant_id, `session not found: ${id}`);

    // ZDR (PR-Z3): purged session's debug_prompt_json is NULLed by the
    // engine. Return 410 with a clear "session purged" reason so the
    // caller can distinguish from never-captured (404) and from the
    // captured-then-expired-by-TTL case (410, different message).
    if (row.status === "purged" || row.retention_purged_at != null) {
      return Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "debug-prompt unavailable — session was purged under zero-data-retention policy",
          },
        },
        { status: 410 },
      );
    }
    if (row.debug_prompt_json === null) {
      throw notFound("debug-prompt capture was not enabled for this session");
    }
    if (row.debug_prompt_json === '{"pending":true}') {
      throw notFound("debug-prompt capture pending — no turn has run yet");
    }

    let payload: CapturedPrompt;
    try {
      payload = JSON.parse(row.debug_prompt_json) as CapturedPrompt;
    } catch {
      // Corrupt JSON — treat as missing.
      throw notFound("debug-prompt payload is corrupt");
    }

    const capturedAtMs = Date.parse(payload.captured_at);
    if (Number.isFinite(capturedAtMs) && nowMs() - capturedAtMs > RETENTION_MS) {
      // Captured payloads expire 1h after capture. Return 410 so
      // callers can tell expired from never-captured.
      return Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `debug-prompt expired (captured ${toIso(capturedAtMs)}, retention 1h)`,
          },
        },
        { status: 410 },
      );
    }

    return Response.json(payload, { status: 200 });
  });
}
