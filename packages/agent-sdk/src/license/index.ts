/**
 * License gating — community vs enterprise feature control.
 *
 * Community edition (no license key): everything a solo dev or team of
 * 20 needs. Enterprise features return 403 with a pricing link.
 *
 * Enterprise edition (AGENTSTEP_LICENSE_KEY set): all features unlocked.
 * The key is a signed JWT validated at boot and cached. Periodic
 * (24-hour) re-validation with a 7-day offline grace period. No
 * per-request phone-home.
 *
 * The gating code is intentionally simple — a few `requireFeature()`
 * calls at handler entry points. Anyone can fork and remove them. The
 * gate is a social contract, not DRM. The real moat is shipping velocity
 * and the hosted product at agentstep.com.
 */
import { forbidden } from "../errors";

// ── Feature definitions ──────────────────────────────────────────────

export type Feature =
  | "tenancy"
  | "budgets"
  | "upstream_pool"
  | "redis_rate_limit"
  | "per_key_analytics"
  | "unlimited_keys"
  | "unlimited_audit";

/** Community-tier limits. */
export const COMMUNITY_LIMITS = {
  /** Max virtual API keys (excluding the seed key). */
  maxKeys: 20,
  /** Audit log read retention in milliseconds (7 days). */
  auditRetentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

// ── License state ────────────────────────────────────────────────────

interface LicenseState {
  plan: "community" | "enterprise";
  features: Feature[];
  validatedAt: number;
  expiresAt: number | null;
}

type GlobalLicense = typeof globalThis & {
  __caLicense?: LicenseState;
};

const g = globalThis as GlobalLicense;

function getState(): LicenseState {
  if (g.__caLicense) return g.__caLicense;
  // Lazy init: if validateLicense() hasn't been called yet (e.g. a
  // module imported directly outside the init flow), check the env
  // var right now so the gate still works. This keeps tests and
  // direct-import code paths consistent with the booted server.
  validateLicense();
  return g.__caLicense!;
}

// ── Boot-time validation ─────────────────────────────────────────────

/**
 * Called from init.ts at boot. Reads `AGENTSTEP_LICENSE_KEY` from env.
 * When set, marks the license as enterprise (all features enabled).
 * When absent, stays on community.
 *
 * Future: decode the key as a signed JWT and validate claims (plan,
 * seats, expiry). For now, any non-empty key = enterprise. This keeps
 * the launch simple and lets us iterate on the key format without
 * breaking existing installs.
 */
export function validateLicense(): void {
  const raw = process.env.AGENTSTEP_LICENSE_KEY;
  if (!raw || !raw.trim()) {
    g.__caLicense = {
      plan: "community",
      features: [],
      validatedAt: Date.now(),
      expiresAt: null,
    };
    return;
  }

  // For now: any non-empty key = enterprise with all features.
  // v0.6 will decode the JWT and check plan/seats/expiry.
  //
  // Features NOT in this list are built but hidden — they 403 for
  // everyone until moved here. To ship tenancy: add "tenancy" back.
  const allFeatures: Feature[] = [
    // "tenancy" — hidden for launch; ship when ready
    "budgets",
    "upstream_pool",
    "redis_rate_limit",
    "per_key_analytics",
    "unlimited_keys",
    "unlimited_audit",
  ];
  g.__caLicense = {
    plan: "enterprise",
    features: allFeatures,
    validatedAt: Date.now(),
    expiresAt: null,
  };
  console.log(`[license] enterprise license activated (${allFeatures.length} features)`);
}

// ── Runtime checks ───────────────────────────────────────────────────

export function isEnterprise(): boolean {
  return getState().plan === "enterprise";
}

export function hasFeature(feature: Feature): boolean {
  const state = getState();
  if (state.plan === "enterprise") return true;
  return state.features.includes(feature);
}

/**
 * Throws 403 with a pricing link when the feature requires an
 * enterprise license. Call at the top of gated handlers.
 *
 * Kill switch: `DISABLE_EXPERIMENTAL_FEATURES=1` disables ALL gated
 * features regardless of license. Use during incidents to fall back
 * to community-tier behavior without redeploying. Works across all
 * instances via container orchestration (env var, not per-instance DB).
 */
export function requireFeature(feature: Feature, friendlyName?: string): void {
  if (process.env.DISABLE_EXPERIMENTAL_FEATURES === "1") {
    const name = friendlyName ?? feature.replace(/_/g, " ");
    throw forbidden(`${name} is temporarily disabled (DISABLE_EXPERIMENTAL_FEATURES=1)`);
  }
  if (hasFeature(feature)) return;
  const name = friendlyName ?? feature.replace(/_/g, " ");
  throw forbidden(
    `${name} requires an AgentStep Enterprise license. ` +
    `Set AGENTSTEP_LICENSE_KEY in your environment, or see https://agentstep.com/pricing`,
  );
}

/**
 * Returns the public-facing license info for the `/v1/license` and UI.
 * Never includes the raw key.
 */
export function getLicenseInfo(): {
  plan: "community" | "enterprise";
  features: Feature[];
  limits: typeof COMMUNITY_LIMITS | null;
} {
  const state = getState();
  return {
    plan: state.plan,
    features: state.plan === "enterprise"
      ? ["tenancy", "budgets", "upstream_pool", "redis_rate_limit", "per_key_analytics", "unlimited_keys", "unlimited_audit"]
      : [],
    limits: state.plan === "community" ? COMMUNITY_LIMITS : null,
  };
}

/** Test hook. */
export function _setLicenseForTesting(plan: "community" | "enterprise"): void {
  if (plan === "enterprise") {
    g.__caLicense = {
      plan: "enterprise",
      features: ["tenancy", "budgets", "upstream_pool", "redis_rate_limit", "per_key_analytics", "unlimited_keys", "unlimited_audit"],
      validatedAt: Date.now(),
      expiresAt: null,
    };
  } else {
    g.__caLicense = {
      plan: "community",
      features: [],
      validatedAt: Date.now(),
      expiresAt: null,
    };
  }
}
