/**
 * HTTP handlers for vault credentials (Anthropic-compatible structured auth).
 *
 * Credentials wrap a secret token with metadata. The token is NEVER returned
 * in API responses -- only the auth shape (type + mcp_server_url) is exposed.
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
import { badRequest, notFound, conflict } from "../errors";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CreateCredentialSchema = z.object({
  display_name: z.string().min(1).max(200),
  auth: z.object({
    type: z.enum(["static_bearer"]),
    token: z.string().min(1),
    mcp_server_url: z.string().url().optional(),
  }),
});

const UpdateCredentialSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  auth: z
    .object({
      type: z.enum(["static_bearer"]).optional(),
      token: z.string().min(1).optional(),
      mcp_server_url: z.string().url().nullish(),
    })
    .optional(),
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

    try {
      const cred = createCredential({
        vault_id: vaultId,
        display_name: parsed.data.display_name,
        auth_type: parsed.data.auth.type,
        token: parsed.data.auth.token,
        mcp_server_url: parsed.data.auth.mcp_server_url ?? null,
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
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard
    const data = listCredentials(vaultId);
    return jsonOk({ data });
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
      const updated = updateCredential(credentialId, {
        display_name: parsed.data.display_name,
        auth_type: parsed.data.auth?.type,
        token: parsed.data.auth?.token,
        mcp_server_url: parsed.data.auth?.mcp_server_url,
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
    return jsonOk({ id: credentialId, type: "credential_deleted" });
  });
}
