/**
 * HTTP handlers for vault credentials (Anthropic-compatible structured auth).
 *
 * Credentials wrap a secret token with metadata. Secret fields are NEVER
 * returned in API responses -- only the auth shape (type + mcp_server_url,
 * and for mcp_oauth, expires_at) is exposed.
 *
 * Supported auth types:
 *   - static_bearer: simple token-based auth
 *   - mcp_oauth: OAuth 2.0 for MCP servers with optional refresh config
 */
import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { loadVaultForCaller } from "./vaults";
import {
  createCredential,
  getCredential,
  listCredentials,
  updateCredential,
  deleteCredential,
} from "../db/credentials";
import type { OAuthRefreshConfig } from "../db/credentials";
import { badRequest, notFound, conflict } from "../errors";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TokenEndpointAuthSchema = z.object({
  type: z.string().min(1),
  client_secret: z.string().min(1),
});

const OAuthRefreshSchema = z.object({
  token_endpoint: z.string().url(),
  client_id: z.string().min(1),
  scope: z.string().optional(),
  refresh_token: z.string().min(1),
  token_endpoint_auth: TokenEndpointAuthSchema.optional(),
});

const StaticBearerAuthSchema = z.object({
  type: z.literal("static_bearer"),
  mcp_server_url: z.string().url().optional(),
  token: z.string().min(1),
});

const McpOauthAuthSchema = z.object({
  type: z.literal("mcp_oauth"),
  mcp_server_url: z.string().url().optional(),
  access_token: z.string().min(1),
  expires_at: z.string().optional(),
  refresh: OAuthRefreshSchema.optional(),
});

const CreateCredentialSchema = z.object({
  display_name: z.string().min(1).max(200),
  auth: z.discriminatedUnion("type", [StaticBearerAuthSchema, McpOauthAuthSchema]),
  metadata: z.record(z.string()).optional(),
});

const UpdateStaticBearerAuthSchema = z.object({
  type: z.literal("static_bearer").optional(),
  token: z.string().min(1).optional(),
  mcp_server_url: z.string().url().nullish(),
});

const UpdateMcpOauthAuthSchema = z.object({
  type: z.literal("mcp_oauth").optional(),
  access_token: z.string().min(1).optional(),
  expires_at: z.string().nullish(),
  refresh: OAuthRefreshSchema.optional(),
});

/** Generic auth update schema -- used for initial parsing. We refine by existing credential type. */
const UpdateAuthSchema = z.object({
  type: z.enum(["static_bearer", "mcp_oauth"]).optional(),
  token: z.string().min(1).optional(),
  mcp_server_url: z.string().url().nullish(),
  access_token: z.string().min(1).optional(),
  expires_at: z.string().nullish(),
  refresh: OAuthRefreshSchema.optional(),
}).optional();

const UpdateCredentialSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  auth: UpdateAuthSchema,
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleCreateCredential(
  request: Request,
  vaultId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard

    const body = await request.json();
    const parsed = CreateCredentialSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const { auth: authData } = parsed.data;

    try {
      if (authData.type === "mcp_oauth") {
        const refreshConfig: OAuthRefreshConfig | null = authData.refresh
          ? {
              token_endpoint: authData.refresh.token_endpoint,
              client_id: authData.refresh.client_id,
              scope: authData.refresh.scope,
              refresh_token: authData.refresh.refresh_token,
              token_endpoint_auth: authData.refresh.token_endpoint_auth,
            }
          : null;
        const cred = createCredential({
          vault_id: vaultId,
          display_name: parsed.data.display_name,
          auth_type: "mcp_oauth",
          token: authData.access_token,
          mcp_server_url: authData.mcp_server_url ?? null,
          expires_at: authData.expires_at ?? null,
          refresh_config: refreshConfig,
        });
        return jsonOk(cred, 201);
      }

      // static_bearer
      const cred = createCredential({
        vault_id: vaultId,
        display_name: parsed.data.display_name,
        auth_type: "static_bearer",
        token: authData.token,
        mcp_server_url: authData.mcp_server_url ?? null,
      });
      return jsonOk(cred, 201);
    } catch (err) {
      // UNIQUE constraint on (vault_id, display_name)
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint failed") || msg.includes("SQLITE_CONSTRAINT")) {
        throw conflict(
          `Credential "${parsed.data.display_name}" already exists in this vault`,
        );
      }
      throw err;
    }
  });
}

export function handleListCredentials(
  request: Request,
  vaultId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard
    const url = new URL(req.url);
    const requestedLimit = Number(url.searchParams.get("limit") || "100");
    const data = listCredentials(vaultId);
    return jsonOk({
      data,
      has_more: data.length === requestedLimit,
      first_id: data.length > 0 ? data[0].id : null,
      last_id: data.length > 0 ? data[data.length - 1].id : null,
    });
  });
}

export function handleGetCredential(
  request: Request,
  vaultId: string,
  credentialId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard
    const cred = getCredential(credentialId);
    if (!cred || cred.vault_id !== vaultId) {
      throw notFound(`credential not found: ${credentialId}`);
    }
    return jsonOk(cred);
  });
}

export function handleUpdateCredential(
  request: Request,
  vaultId: string,
  credentialId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard

    // Verify the credential belongs to this vault
    const existing = getCredential(credentialId);
    if (!existing || existing.vault_id !== vaultId) {
      throw notFound(`credential not found: ${credentialId}`);
    }

    const body = await request.json();
    const parsed = UpdateCredentialSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    try {
      const authData = parsed.data.auth;
      // Use existing credential's auth type to interpret update fields
      const isMcpOauth = existing.auth.type === "mcp_oauth" ||
        authData?.type === "mcp_oauth";

      if (isMcpOauth && authData) {
        // mcp_oauth update fields
        const refreshConfig: OAuthRefreshConfig | undefined = authData.refresh
          ? {
              token_endpoint: authData.refresh.token_endpoint,
              client_id: authData.refresh.client_id,
              scope: authData.refresh.scope,
              refresh_token: authData.refresh.refresh_token,
              token_endpoint_auth: authData.refresh.token_endpoint_auth,
            }
          : undefined;
        const updated = updateCredential(credentialId, {
          display_name: parsed.data.display_name,
          auth_type: authData.type,
          token: authData.access_token,
          expires_at: authData.expires_at,
          refresh_config: refreshConfig,
        });
        if (!updated) throw notFound(`credential not found: ${credentialId}`);
        return jsonOk(updated);
      }

      // static_bearer update fields
      const updated = updateCredential(credentialId, {
        display_name: parsed.data.display_name,
        auth_type: authData?.type,
        token: authData?.token,
        mcp_server_url: authData?.mcp_server_url,
      });
      if (!updated) throw notFound(`credential not found: ${credentialId}`);
      return jsonOk(updated);
    } catch (err) {
      if (err instanceof Error && (err.message.includes("UNIQUE constraint failed") || err.message.includes("SQLITE_CONSTRAINT"))) {
        throw conflict(
          `Credential "${parsed.data.display_name}" already exists in this vault`,
        );
      }
      throw err;
    }
  });
}

export function handleDeleteCredential(
  request: Request,
  vaultId: string,
  credentialId: string,
): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard

    // Verify the credential belongs to this vault
    const existing = getCredential(credentialId);
    if (!existing || existing.vault_id !== vaultId) {
      throw notFound(`credential not found: ${credentialId}`);
    }

    const deleted = deleteCredential(credentialId);
    if (!deleted) throw notFound(`credential not found: ${credentialId}`);
    return jsonOk({ id: credentialId, type: "vault_credential_deleted" });
  });
}
