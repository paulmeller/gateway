/**
 * Sync Anthropic-side files to local DB on turn completion.
 *
 * When a sync-and-proxy session's turn completes (status_idle event),
 * this hook fetches the file list from Anthropic and upserts metadata
 * into the local `files` table. File content is NOT fetched eagerly —
 * the `storage_path` sentinel `remote:<anthropicFileId>` signals lazy
 * on-demand proxy in `handleGetFileContent`.
 *
 * Fires via the `onAfterCommit` hook in sessions/bus.ts — same pattern
 * as the OTLP exporter. Fire-and-forget; errors are logged, never block.
 */
import { onAfterCommit } from "../sessions/bus";
import { isProxied } from "../db/proxy";
import { getSession } from "../db/sessions";
import { getDb } from "../db/client";
import { createFile } from "../db/files";
import { resolveRemoteSessionId } from "../db/sync";
import { resolveAnthropicKey } from "../providers/upstream-keys";

const ANTHROPIC_API = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01,files-api-2025-04-14";

interface AnthropicFile {
  id: string;
  filename: string;
  size: number;
  mime_type?: string;
  content_type?: string;
  created_at?: string;
}

/**
 * Fetch the file list from Anthropic for a given remote session and
 * upsert each file's metadata into the local DB. Deduplicates via
 * the `anthropic_sync` table so repeated idle events don't create
 * duplicate rows.
 */
async function syncRemoteFiles(sessionId: string): Promise<void> {
  const resolved = resolveAnthropicKey({ sessionId });
  if (!resolved) return; // no key — can't fetch

  const remoteSessionId = resolveRemoteSessionId(sessionId);

  const res = await fetch(
    `${ANTHROPIC_API}/v1/files?scope_id=${remoteSessionId}`,
    {
      headers: {
        "x-api-key": resolved.value,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": BETA_HEADER,
      },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!res.ok) {
    console.warn(`[file-sync] Anthropic files list failed: ${res.status}`);
    return;
  }

  const body = (await res.json()) as { data?: AnthropicFile[] };
  const files = body.data;
  if (!files || files.length === 0) return;

  const db = getDb();
  for (const f of files) {
    // Dedup: skip if we already have a file row with this remote ID
    // in the storage_path. Simpler than using anthropic_sync (which
    // has a CHECK constraint that doesn't include 'file' on existing DBs).
    const storagePath = `remote:${f.id}`;
    const existing = db
      .prepare(`SELECT id FROM files WHERE storage_path = ?`)
      .get(storagePath) as { id: string } | undefined;
    if (existing) continue;

    createFile({
      filename: f.filename ?? "output",
      size: f.size ?? 0,
      content_type: f.mime_type ?? f.content_type ?? "application/octet-stream",
      storage_path: storagePath,
      scope: { type: "session", id: sessionId },
    });
  }
}

/**
 * Register the after-commit hook. Call once from init.ts at boot.
 */
export function installFileSyncHook(): () => void {
  return onAfterCommit((sessionId, row) => {
    if (row.type !== "session.status_idle") return;
    if (!isProxied(sessionId)) return;
    if (!getSession(sessionId)) return; // pure-proxy — no local row to attach files to

    void syncRemoteFiles(sessionId).catch((err) => {
      console.warn("[file-sync] failed:", err);
    });
  });
}
