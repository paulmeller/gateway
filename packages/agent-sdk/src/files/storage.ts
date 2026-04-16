/**
 * Local file storage.
 *
 * Files are stored at: data/files/{file_id}/{filename}
 * This keeps filenames intact while using the ULID as the directory name
 * for uniqueness. The `data/` directory is relative to cwd (same as the DB).
 */
import fs from "node:fs";
import path from "node:path";

const FILES_DIR = path.join(process.cwd(), "data", "files");

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Store a file on disk. Returns the storage path relative to cwd. */
export function storeFile(fileId: string, filename: string, data: Buffer): string {
  const dir = path.join(FILES_DIR, fileId);
  ensureDir(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, data);
  return path.relative(process.cwd(), filePath);
}

/** Read a file from disk. Returns the raw buffer. */
export function readFile(storagePath: string): Buffer {
  const abs = path.resolve(process.cwd(), storagePath);
  return fs.readFileSync(abs);
}

/** Delete a file and its directory from disk. */
export function deleteFile(storagePath: string): void {
  const abs = path.resolve(process.cwd(), storagePath);
  const dir = path.dirname(abs);
  try {
    fs.unlinkSync(abs);
    // Remove directory if empty
    const remaining = fs.readdirSync(dir);
    if (remaining.length === 0) fs.rmdirSync(dir);
  } catch {
    // Best-effort — file may already be gone
  }
}

/** Get the absolute path for a storage path. */
export function getAbsolutePath(storagePath: string): string {
  return path.resolve(process.cwd(), storagePath);
}

/** Default max file size: 50MB (configurable via FILE_SIZE_LIMIT env). */
export function getMaxFileSize(): number {
  const env = process.env.FILE_SIZE_LIMIT;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 50 * 1024 * 1024; // 50MB
}
