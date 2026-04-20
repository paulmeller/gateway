import { routeWrap, jsonOk } from "../http";
import { writeSetting, readSetting } from "../config";
import { badRequest, notFound } from "../errors";

/** Non-secret settings — plain JSON-like values the UI can read verbatim. */
const NON_SECRET_KEYS = new Set([
  "saved_repositories",
  // Provider identifiers (not credentials) — safe to surface in the API
  // so the UI can show "configured as team XYZ, project ABC".
  "vercel_team_id",
  "vercel_project_id",
  "fly_app_name",
  // Skills catalog URL overrides — URLs, not secrets.
  "skills_feed_url",
  "skills_index_url",
]);

/** All writable/readable setting keys. Anything not in NON_SECRET_KEYS is a secret. */
const ALLOWED_KEYS = [
  // Engine + cloud provider credentials
  "sprite_token", "anthropic_api_key", "openai_api_key",
  "gemini_api_key", "factory_api_key", "claude_token",
  "e2b_api_key", "vercel_token", "daytona_api_key",
  "fly_api_token", "modal_token_id", "modal_token_secret",
  // Provider identifiers (not secrets but pair with credentials)
  "vercel_team_id", "vercel_project_id", "fly_app_name",
  // Skills catalog URL overrides (operator override; default is agentstep.com)
  "skills_feed_url", "skills_index_url",
  // UI state
  "saved_repositories",
];

/**
 * Derived from ALLOWED_KEYS / NON_SECRET_KEYS so the two sets can't drift.
 * Responses for secret keys always mask the value so the API doesn't echo
 * secrets back in plaintext. The vault (with per-instance AES encryption)
 * is the authoritative store for agent-side use.
 */
const SECRET_KEYS = new Set(ALLOWED_KEYS.filter((k) => !NON_SECRET_KEYS.has(k)));

/** Render a secret as "sk-an••••••••••lAQR" — first 6 + last 4 chars, ≥8 bullets. */
function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 12) return "••••••••";
  return `${value.slice(0, 6)}${"•".repeat(Math.max(8, value.length - 10))}${value.slice(-4)}`;
}

export function handlePutSetting(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const body = await request.json().catch(() => null) as { key?: string; value?: string } | null;
    if (!body?.key || typeof body.value !== "string") {
      throw badRequest("key and value are required");
    }

    if (!ALLOWED_KEYS.includes(body.key)) {
      throw badRequest(`setting "${body.key}" is not writable via API`);
    }

    writeSetting(body.key, body.value);
    return jsonOk({ ok: true });
  });
}

export function handleGetSetting(request: Request, key: string): Promise<Response> {
  return routeWrap(request, async () => {
    if (!ALLOWED_KEYS.includes(key)) {
      throw badRequest(`setting "${key}" is not readable via API`);
    }
    const value = readSetting(key);
    if (value === undefined) {
      return jsonOk({ key, value: null, configured: false });
    }
    if (SECRET_KEYS.has(key)) {
      // Never return the raw secret over the API — return a masked preview
      // plus a boolean so the UI can show "configured" state without
      // exposing the value. This is consistent with /v1/vaults masking.
      return jsonOk({ key, value: maskSecret(value), configured: true, masked: true });
    }
    return jsonOk({ key, value, configured: true });
  });
}
