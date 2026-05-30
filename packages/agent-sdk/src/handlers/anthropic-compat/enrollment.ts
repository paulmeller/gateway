/**
 * OAuth enrollment flow for user profiles.
 *
 * Generates an authorization URL that a user can visit to authorize
 * their identity with an external OAuth provider. On callback, the
 * gateway exchanges the authorization code for tokens and stores them
 * as a credential linked to the user's profile trust grants.
 *
 * Flow:
 *   1. POST /v1/user_profiles/:id/enrollment_url → returns { url }
 *   2. User visits the URL, authorizes
 *   3. Provider redirects to GET /v1/oauth/callback?code=...&state=...
 *   4. Gateway exchanges code → tokens, creates/updates credential
 */
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { routeWrap, jsonOk } from "../../http";
import { badRequest, notFound } from "../../errors";
import { tenantFilter } from "../../auth/scope";
import { getUserProfile, updateUserProfile } from "../../db/user-profiles";
import type { TrustGrant } from "../../db/user-profiles";
import { createCredential, updateCredential, getCredential } from "../../db/credentials";

// ---------------------------------------------------------------------------
// In-memory pending enrollment state (ephemeral — lost on restart)
// ---------------------------------------------------------------------------

interface PendingEnrollment {
  profileId: string;
  vaultId: string;
  credentialId: string | null; // null = create new, string = update existing
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  redirectUri: string;
  createdAt: number;
}

const pendingEnrollments = new Map<string, PendingEnrollment>();

// Clean up enrollments older than 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [state, enrollment] of pendingEnrollments) {
    if (enrollment.createdAt < cutoff) pendingEnrollments.delete(state);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EnrollmentSchema = z.object({
  vault_id: z.string().min(1),
  credential_id: z.string().optional(), // update existing credential, or omit to create new
  display_name: z.string().min(1).optional(), // required when creating new
  authorize_url: z.string().url(),
  token_endpoint: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
  redirect_uri: z.string().url().optional(),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleEnrollmentUrl(
  request: Request,
  profileId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const profile = getUserProfile(profileId);
    if (!profile) throw notFound(`user profile not found: ${profileId}`);

    const filter = tenantFilter(auth);
    if (filter && profile.tenant_id !== filter) {
      throw notFound(`user profile not found: ${profileId}`);
    }

    const body = await request.json().catch(() => null);
    const parsed = EnrollmentSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(`invalid body: ${parsed.error.issues.map(i => i.message).join("; ")}`);
    }

    const data = parsed.data;

    // If updating an existing credential, verify it exists
    if (data.credential_id) {
      const cred = getCredential(data.credential_id);
      if (!cred || cred.vault_id !== data.vault_id) {
        throw badRequest(`credential not found: ${data.credential_id}`);
      }
    } else if (!data.display_name) {
      throw badRequest("display_name is required when creating a new credential");
    }

    // Generate state token
    const state = randomBytes(32).toString("hex");

    // Determine redirect URI from the request origin or caller-provided value
    const reqUrl = new URL(request.url);
    const redirectUri = data.redirect_uri || `${reqUrl.origin}/v1/oauth/callback`;

    // Store pending enrollment
    pendingEnrollments.set(state, {
      profileId,
      vaultId: data.vault_id,
      credentialId: data.credential_id ?? null,
      tokenEndpoint: data.token_endpoint,
      clientId: data.client_id,
      clientSecret: data.client_secret,
      scope: data.scope,
      redirectUri,
      createdAt: Date.now(),
    });

    // Build authorization URL
    const params = new URLSearchParams({
      response_type: "code",
      client_id: data.client_id,
      redirect_uri: redirectUri,
      state,
      ...(data.scope ? { scope: data.scope } : {}),
    });

    const url = `${data.authorize_url}?${params.toString()}`;

    return jsonOk({
      type: "enrollment_url",
      url,
      state,
      redirect_uri: redirectUri,
      expires_in: 600, // 10 minutes
    });
  });
}

/**
 * OAuth callback handler. Exchanges authorization code for tokens,
 * creates/updates the credential, and adds it to the user profile's
 * trust grants.
 *
 * This endpoint is hit by the browser redirect from the OAuth provider —
 * it has no API key. Auth is verified via the state token (only someone
 * who called enrollment_url has a valid state).
 */
export async function handleOAuthCallback(request: Request): Promise<Response> {
  // Import ensureInitialized to guarantee DB is ready (routeWrap normally does this)
  const { ensureInitialized } = await import("../../init");
  await ensureInitialized();

  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      return new Response(
        `<html><body><h2>Authorization failed</h2><p>${error}</p></body></html>`,
        { status: 400, headers: { "Content-Type": "text/html" } },
      );
    }

    if (!code || !state) {
      return new Response(
        `<html><body><h2>Missing code or state parameter</h2></body></html>`,
        { status: 400, headers: { "Content-Type": "text/html" } },
      );
    }

    const enrollment = pendingEnrollments.get(state);
    if (!enrollment) {
      return new Response(
        `<html><body><h2>Invalid or expired enrollment state</h2><p>Please restart the enrollment process.</p></body></html>`,
        { status: 400, headers: { "Content-Type": "text/html" } },
      );
    }
    pendingEnrollments.delete(state);

    // Exchange code for tokens
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: enrollment.clientId,
      redirect_uri: enrollment.redirectUri,
      ...(enrollment.scope ? { scope: enrollment.scope } : {}),
    });
    if (enrollment.clientSecret) {
      body.set("client_secret", enrollment.clientSecret);
    }

    const tokenRes = await fetch(enrollment.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => "");
      return new Response(
        `<html><body><h2>Token exchange failed</h2><p>${tokenRes.status}: ${errText.slice(0, 200)}</p></body></html>`,
        { status: 502, headers: { "Content-Type": "text/html" } },
      );
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    // Create or update credential
    let credentialId: string;
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    const refreshConfig = tokens.refresh_token
      ? {
          token_endpoint: enrollment.tokenEndpoint,
          client_id: enrollment.clientId,
          scope: enrollment.scope ?? tokens.scope,
          refresh_token: tokens.refresh_token,
          ...(enrollment.clientSecret
            ? { token_endpoint_auth: { type: "client_secret_post", client_secret: enrollment.clientSecret } }
            : {}),
        }
      : null;

    if (enrollment.credentialId) {
      // Update existing
      updateCredential(enrollment.credentialId, {
        auth_type: "mcp_oauth",
        token: tokens.access_token,
        expires_at: expiresAt,
        refresh_config: refreshConfig,
      });
      credentialId = enrollment.credentialId;
    } else {
      // Create new credential (need display_name from pending — stored on profile query)
      const profile = getUserProfile(enrollment.profileId);
      const displayName = `oauth-${enrollment.clientId}-${Date.now()}`;
      const cred = createCredential({
        vault_id: enrollment.vaultId,
        display_name: displayName,
        auth_type: "mcp_oauth",
        token: tokens.access_token,
        expires_at: expiresAt,
        refresh_config: refreshConfig,
      });
      credentialId = cred.id;
    }

    // Add trust grant to user profile (if not already present)
    const profile = getUserProfile(enrollment.profileId);
    if (profile) {
      const existingGrant = profile.trust_grants.find(
        (g) => g.vault_id === enrollment.vaultId && g.credential_id === credentialId,
      );
      if (!existingGrant) {
        const newGrants: TrustGrant[] = [
          ...profile.trust_grants,
          { type: "vault_credential", vault_id: enrollment.vaultId, credential_id: credentialId },
        ];
        updateUserProfile(enrollment.profileId, { trust_grants: newGrants });
      }
    }

    return new Response(
      `<html><body><h2>Enrollment complete</h2><p>Credential ${credentialId} has been linked to your profile. You can close this window.</p></body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      `<html><body><h2>Enrollment error</h2><p>${msg}</p></body></html>`,
      { status: 500, headers: { "Content-Type": "text/html" } },
    );
  }
}
