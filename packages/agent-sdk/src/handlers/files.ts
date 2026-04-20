/**
 * File upload/download handlers.
 *
 * POST /v1/files          — upload (multipart/form-data or raw body)
 * GET  /v1/files          — list files
 * GET  /v1/files/:id      — get file metadata
 * GET  /v1/files/:id/content — download file content
 * DELETE /v1/files/:id    — delete file
 */
import { routeWrap, jsonOk } from "../http";
import { getDb } from "../db/client";
import { createFile, getFile, getFileRecord, listFiles, deleteFileRecord, updateFileStoragePath } from "../db/files";
import { storeFile, readFile, deleteFile, getMaxFileSize } from "../files/storage";
import { badRequest, notFound } from "../errors";
import { assertResourceTenant } from "../auth/scope";
import type { AuthContext } from "../types";

/**
 * Files are scoped to a session (v0.4+). Validate the caller can see
 * the owning session before letting them upload/read/delete. Unscoped
 * files (legacy rows) are only available to global admins.
 */
function assertFileTenantByScope(
  auth: AuthContext,
  scopeType: string | null,
  scopeId: string | null,
): void {
  if (!scopeId || scopeType !== "session") {
    if (!auth.isGlobalAdmin) throw notFound("file not found");
    return;
  }
  const row = getDb()
    .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
    .get(scopeId) as { tenant_id: string | null } | undefined;
  if (!row) throw notFound("file not found");
  assertResourceTenant(auth, row.tenant_id, "file not found");
}

export function handleUploadFile(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const contentType = req.headers.get("content-type") ?? "";
    let filename: string;
    let data: Buffer;
    let fileContentType: string;

    if (contentType.includes("multipart/form-data")) {
      // Multipart upload
      const formData = await req.formData();
      const file = formData.get("file");
      if (!file || !(file instanceof File)) {
        throw badRequest("Missing 'file' field in multipart form data");
      }
      filename = file.name || "upload";
      fileContentType = file.type || "application/octet-stream";
      const ab = await file.arrayBuffer();
      data = Buffer.from(ab);
    } else {
      // Raw body upload — filename from header or query
      const url = new URL(req.url);
      filename = url.searchParams.get("filename") || req.headers.get("x-filename") || "upload";
      fileContentType = contentType || "application/octet-stream";
      const ab = await req.arrayBuffer();
      data = Buffer.from(ab);
    }

    if (data.length === 0) {
      throw badRequest("Empty file");
    }

    const maxSize = getMaxFileSize();
    if (data.length > maxSize) {
      throw badRequest(`File too large: ${data.length} bytes (max ${maxSize})`);
    }

    // Parse optional scope from query params or form data
    const url = new URL(req.url);
    const scopeId = url.searchParams.get("scope_id");
    const scopeType = url.searchParams.get("scope_type") || "session";
    const scope = scopeId ? { type: scopeType as "session", id: scopeId } : undefined;

    // Tenant check — tenant users must upload into one of their sessions.
    // Global admins may upload unscoped files or into any tenant's session.
    assertFileTenantByScope(auth, scope?.type ?? null, scope?.id ?? null);

    // Store on disk
    const record = createFile({
      filename,
      size: data.length,
      content_type: fileContentType,
      storage_path: "", // placeholder — set after store
      scope,
    });
    const storagePath = storeFile(record.id, filename, data);

    // Update storage path in DB
    updateFileStoragePath(record.id, storagePath);

    return jsonOk(record, 201);
  });
}

export function handleListFiles(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") || "100");
    const scope_id = url.searchParams.get("scope_id") || undefined;
    if (scope_id) {
      // Tenant-scoped listing — caller must own the session the files
      // are attached to. Unknown scope_id → 404 (matches the pattern
      // used by every other get-by-id handler; "empty list for
      // unknown id" would silently let typos pass). Unscoped listings
      // are global-admin-only.
      const row = getDb()
        .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
        .get(scope_id) as { tenant_id: string | null } | undefined;
      if (!row) throw notFound(`session not found: ${scope_id}`);
      assertResourceTenant(auth, row.tenant_id, `session not found: ${scope_id}`);
    } else if (!auth.isGlobalAdmin) {
      // Tenant users can't fetch an unscoped file list. Force scope_id.
      throw badRequest("scope_id is required for tenant-scoped listings");
    }
    const files = listFiles({ limit, scope_id });
    return jsonOk({ data: files });
  });
}

export function handleGetFile(request: Request, fileId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const record = getFileRecord(fileId);
    if (!record) throw notFound(`file not found: ${fileId}`);
    assertFileTenantByScope(auth, record.scope?.type ?? null, record.scope?.id ?? null);
    return jsonOk(record);
  });
}

export function handleGetFileContent(request: Request, fileId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const row = getFile(fileId);
    if (!row) throw notFound(`file not found: ${fileId}`);
    assertFileTenantByScope(auth, row.scope_type, row.scope_id);

    // Lazy content proxy for Anthropic-side files. The metadata was
    // synced by file-sync.ts on turn completion; the content is fetched
    // on demand here so we don't pre-download every output file.
    if (row.storage_path.startsWith("remote:")) {
      const remoteFileId = row.storage_path.slice(7);
      const { resolveAnthropicKey } = await import("../providers/upstream-keys");
      const resolved = resolveAnthropicKey({
        sessionId: row.scope_id ?? undefined,
      });
      if (!resolved) throw notFound("file content unavailable (no API key)");

      const upstream = await fetch(
        `https://api.anthropic.com/v1/files/${remoteFileId}/content`,
        {
          headers: {
            "x-api-key": resolved.value,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "managed-agents-2026-04-01,files-api-2025-04-14",
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!upstream.ok) throw notFound(`file content unavailable (upstream ${upstream.status})`);

      return new Response(upstream.body, {
        headers: {
          "Content-Type": row.content_type,
          "Content-Disposition": `attachment; filename="${row.filename}"`,
        },
      });
    }

    const data = readFile(row.storage_path);
    return new Response(data, {
      headers: {
        "Content-Type": row.content_type,
        "Content-Disposition": `attachment; filename="${row.filename}"`,
        "Content-Length": String(data.length),
      },
    });
  });
}

export function handleDeleteFile(request: Request, fileId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const row = getFile(fileId);
    if (!row) throw notFound(`file not found: ${fileId}`);
    assertFileTenantByScope(auth, row.scope_type, row.scope_id);

    // Delete from disk
    deleteFile(row.storage_path);
    // Delete from DB
    const result = deleteFileRecord(fileId);
    return jsonOk(result);
  });
}
