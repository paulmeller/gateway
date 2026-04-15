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
import { createFile, getFile, getFileRecord, listFiles, deleteFileRecord } from "../db/files";
import { storeFile, readFile, deleteFile, getMaxFileSize } from "../files/storage";
import { badRequest, notFound } from "../errors";

export function handleUploadFile(request: Request): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
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
    const { getDb } = await import("../db/client");
    getDb().prepare("UPDATE files SET storage_path = ? WHERE id = ?").run(storagePath, record.id);

    return jsonOk(record, 201);
  });
}

export function handleListFiles(request: Request): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get("limit") || "100");
    const scope_id = url.searchParams.get("scope_id") || undefined;
    const files = listFiles({ limit, scope_id });
    return jsonOk({ data: files });
  });
}

export function handleGetFile(request: Request, fileId: string): Promise<Response> {
  return routeWrap(request, async () => {
    const record = getFileRecord(fileId);
    if (!record) throw notFound(`file not found: ${fileId}`);
    return jsonOk(record);
  });
}

export function handleGetFileContent(request: Request, fileId: string): Promise<Response> {
  return routeWrap(request, async () => {
    const row = getFile(fileId);
    if (!row) throw notFound(`file not found: ${fileId}`);

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
  return routeWrap(request, async () => {
    const row = getFile(fileId);
    if (!row) throw notFound(`file not found: ${fileId}`);

    // Delete from disk
    deleteFile(row.storage_path);
    // Delete from DB
    const result = deleteFileRecord(fileId);
    return jsonOk(result);
  });
}
