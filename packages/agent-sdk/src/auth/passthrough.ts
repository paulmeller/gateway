/**
 * Anthropic API passthrough — shape detection and route allowlist.
 *
 * Passthrough lets a client point an Anthropic SDK at the gateway with
 * their existing `sk-ant-api*` key. The gateway forwards to Anthropic
 * using that key, with no gateway-side state created. Anthropic-shaped
 * routes live under the `/anthropic/v1/*` prefix (mirroring the path
 * convention used for `/google/v1beta/*`), and the allowlist below is
 * the authoritative source for which routes are forwarded.
 *
 * Two invariants keep this safe:
 *
 *   1. Shape-based mode selection (not lookup-miss). A key matching
 *      `sk-ant-api*` is *only* ever treated as a passthrough key — it
 *      is never compared against the local `api_keys` table. A key
 *      *not* matching that shape is *only* ever compared against the
 *      local table. The two key spaces don't overlap (gateway keys are
 *      `ck_*`), so there's no collision and no side channel that lets
 *      a caller probe "is this a valid gateway key".
 *
 *   2. Route allowlist. Even with a valid `sk-ant-api*` key, only
 *      routes that mirror Anthropic's API are forwarded. Gateway-only
 *      routes (api-keys, settings, metrics, tenants, upstream-keys,
 *      audit, license, traces, providers, models, batch, skills,
 *      whoami, memory) reject passthrough — otherwise an Anthropic-key
 *      holder could enumerate gateway state.
 *
 * `sk-ant-oat*` (OAuth tokens) intentionally do NOT match — the
 * existing anthropic-provider sync flow rejects them (see
 * `handlers/anthropic-compat/sessions.ts`), so we keep the same posture in passthrough.
 */

/**
 * Anthropic API key shape. Matches `sk-ant-api{version-digits}-{rest}`,
 * which is the format Anthropic issues today. The minimum length after
 * the prefix is generous — short enough to accept future versions, long
 * enough that a typo or partial paste won't be forwarded as a key.
 *
 * `sk-ant-oat*` (OAuth tokens) does NOT match — that prefix is excluded
 * by the literal `api` after `sk-ant-`.
 */
const ANTHROPIC_API_KEY_RE = /^sk-ant-api[A-Za-z0-9_-]{20,}$/;

export function isAnthropicApiKey(key: string): boolean {
  return ANTHROPIC_API_KEY_RE.test(key);
}

/**
 * Anthropic OAuth token shape. `sk-ant-oat*` issued by `claude setup-token`
 * for subscription-OAuth flows. Distinct from API keys: requires header
 * remapping (CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY) and is rejected
 * by the gateway's anthropic-proxy provider for hosted execution.
 *
 * Centralised here so the five places that previously did
 * `value.startsWith("sk-ant-oat")` inline agree on the predicate.
 */
export function isAnthropicOAuthToken(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("sk-ant-oat");
}

/**
 * Routes under `/anthropic/v1/*` that mirror Anthropic's Managed Agents
 * API and may be forwarded via passthrough. A request whose normalized
 * path matches any of these patterns will be proxied to
 * `https://api.anthropic.com/v1<rest>` using the caller's `sk-ant-api*`
 * key (the `/anthropic` prefix is stripped before forwarding).
 *
 * Gateway-only paths (anything not on this list) reject passthrough
 * with 401, regardless of feature flag. Don't add a route here unless
 * Anthropic exposes the equivalent endpoint at the same path under
 * their `/v1/*` namespace.
 */
const PASSTHROUGH_ROUTE_PATTERNS: RegExp[] = [
  // Agents
  /^\/anthropic\/v1\/agents$/,
  /^\/anthropic\/v1\/agents\/[^/]+$/,
  /^\/anthropic\/v1\/agents\/[^/]+\/archive$/,
  /^\/anthropic\/v1\/agents\/[^/]+\/versions$/,
  // Sessions + sub-resources
  /^\/anthropic\/v1\/sessions$/,
  /^\/anthropic\/v1\/sessions\/[^/]+$/,
  /^\/anthropic\/v1\/sessions\/[^/]+\/archive$/,
  /^\/anthropic\/v1\/sessions\/[^/]+\/events$/,
  /^\/anthropic\/v1\/sessions\/[^/]+\/events\/stream$/,
  /^\/anthropic\/v1\/sessions\/[^/]+\/resources$/,
  /^\/anthropic\/v1\/sessions\/[^/]+\/resources\/[^/]+$/,
  /^\/anthropic\/v1\/sessions\/[^/]+\/threads$/,
  /^\/anthropic\/v1\/sessions\/[^/]+\/threads\/[^/]+$/,
  /^\/anthropic\/v1\/sessions\/[^/]+\/threads\/[^/]+\/archive$/,
  /^\/anthropic\/v1\/sessions\/[^/]+\/threads\/[^/]+\/events$/,
  /^\/anthropic\/v1\/sessions\/[^/]+\/threads\/[^/]+\/stream$/,
  // Vaults + entries + credentials
  /^\/anthropic\/v1\/vaults$/,
  /^\/anthropic\/v1\/vaults\/[^/]+$/,
  /^\/anthropic\/v1\/vaults\/[^/]+\/archive$/,
  /^\/anthropic\/v1\/vaults\/[^/]+\/entries$/,
  /^\/anthropic\/v1\/vaults\/[^/]+\/entries\/[^/]+$/,
  /^\/anthropic\/v1\/vaults\/[^/]+\/credentials$/,
  /^\/anthropic\/v1\/vaults\/[^/]+\/credentials\/[^/]+$/,
  /^\/anthropic\/v1\/vaults\/[^/]+\/credentials\/[^/]+\/archive$/,
  /^\/anthropic\/v1\/vaults\/[^/]+\/credentials\/[^/]+\/mcp_oauth_validate$/,
  // Environments + work queue
  /^\/anthropic\/v1\/environments$/,
  /^\/anthropic\/v1\/environments\/[^/]+$/,
  /^\/anthropic\/v1\/environments\/[^/]+\/archive$/,
  /^\/anthropic\/v1\/environments\/[^/]+\/work$/,
  /^\/anthropic\/v1\/environments\/[^/]+\/work\/poll$/,
  /^\/anthropic\/v1\/environments\/[^/]+\/work\/stats$/,
  /^\/anthropic\/v1\/environments\/[^/]+\/work\/[^/]+$/,
  /^\/anthropic\/v1\/environments\/[^/]+\/work\/[^/]+\/ack$/,
  /^\/anthropic\/v1\/environments\/[^/]+\/work\/[^/]+\/heartbeat$/,
  /^\/anthropic\/v1\/environments\/[^/]+\/work\/[^/]+\/stop$/,
  // Files
  /^\/anthropic\/v1\/files$/,
  /^\/anthropic\/v1\/files\/[^/]+$/,
  /^\/anthropic\/v1\/files\/[^/]+\/content$/,
  // Skills (CMA, beta `skills-2025-10-02`) — PR9 moved these from
  // /v1/* to /anthropic/v1/*; the matching passthrough rules were
  // missed in that change, breaking Counselproof's deploy script's
  // GET /anthropic/v1/skills against a real sk-ant-api* key.
  /^\/anthropic\/v1\/skills$/,
  /^\/anthropic\/v1\/skills\/[^/]+$/,
  /^\/anthropic\/v1\/skills\/[^/]+\/versions$/,
  /^\/anthropic\/v1\/skills\/[^/]+\/versions\/[^/]+$/,
  /^\/anthropic\/v1\/skills\/[^/]+\/versions\/[^/]+\/content$/,
  // Memory stores (CMA, beta `managed-agents-2026-04-01`)
  /^\/anthropic\/v1\/memory_stores$/,
  /^\/anthropic\/v1\/memory_stores\/[^/]+$/,
  /^\/anthropic\/v1\/memory_stores\/[^/]+\/archive$/,
  /^\/anthropic\/v1\/memory_stores\/[^/]+\/memories$/,
  /^\/anthropic\/v1\/memory_stores\/[^/]+\/memories\/[^/]+$/,
  /^\/anthropic\/v1\/memory_stores\/[^/]+\/memory_versions$/,
  /^\/anthropic\/v1\/memory_stores\/[^/]+\/memory_versions\/[^/]+$/,
  /^\/anthropic\/v1\/memory_stores\/[^/]+\/memory_versions\/[^/]+\/redact$/,
  // Models
  /^\/anthropic\/v1\/models$/,
  /^\/anthropic\/v1\/models\/[^/]+$/,
  // User profiles
  /^\/anthropic\/v1\/user_profiles$/,
  /^\/anthropic\/v1\/user_profiles\/[^/]+$/,
  /^\/anthropic\/v1\/user_profiles\/[^/]+\/enrollment_url$/,
  // Messages API — escape hatch for features Managed Agents doesn't
  // expose (tool_choice forcing, assistant prefill). A passthrough
  // caller can mix `/anthropic/v1/sessions/*` (Managed Agents) and
  // `/anthropic/v1/messages` (raw Messages API) under one base URL +
  // one sk-ant-api* key. Forwards to `api.anthropic.com/v1/messages`
  // unchanged — gateway adds nothing, strips nothing.
  /^\/anthropic\/v1\/messages$/,
  /^\/anthropic\/v1\/messages\/count_tokens$/,
];

export function isPassthroughAllowedPath(pathname: string): boolean {
  return PASSTHROUGH_ROUTE_PATTERNS.some((re) => re.test(pathname));
}
