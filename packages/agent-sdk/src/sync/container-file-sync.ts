/**
 * Container file sync — extract modified files from a container after a turn.
 *
 * After a local (non-proxied) session turn completes, this module reads
 * the files that the agent modified (via Write/Edit/file_edit tool calls)
 * and stores them in the gateway's file store. This makes container-side
 * file changes visible in the UI and downloadable via the Files API.
 *
 * Only Claude and Codex backends are supported in v1 — they emit structured
 * tool_use events with file paths that this module can parse.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { listEvents } from "../db/events";
import { createFile, findFileByContainerPath } from "../db/files";
import { storeFile } from "../files/storage";
import { newId } from "../util/ids";
import type { ContainerProvider, ProviderSecrets } from "../providers/types";

/** Extensions to skip entirely (build artifacts, not deliverables). */
const BINARY_EXTENSIONS = new Set([
  ".o", ".pyc", ".so", ".dylib", ".bin", ".wasm",
  ".mp3", ".mp4",
]);

/** Blocked path prefixes — system directories that should never be synced. */
const BLOCKED_PREFIXES = [
  "/proc/", "/sys/", "/dev/", "/etc/", "/bin/", "/sbin/",
  "/usr/bin/", "/usr/sbin/", "/usr/lib/", "/var/run/", "/var/log/",
];

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_FILES_PER_SYNC = 20;

/**
 * Extract file paths from recent tool_use events in the session.
 *
 * Looks for:
 *   - Claude: tool name `Write` or `Edit` with `input.file_path`
 *   - Codex:  tool name `file_edit` with `input.path`
 */
interface ExtractResult {
  paths: string[];
  sawFileTools: boolean;
  sawBash: boolean;
}

function extractFilePaths(sessionId: string): ExtractResult {
  const events = listEvents(sessionId, { limit: 500, order: "desc" });
  const seen = new Set<string>();
  const paths: string[] = [];
  let sawFileTools = false;
  let sawBash = false;

  for (const evt of events) {
    if (evt.type !== "agent.tool_use") continue;
    let payload: { name?: string; input?: Record<string, unknown> };
    try {
      payload = JSON.parse(evt.payload_json) as typeof payload;
    } catch {
      continue;
    }

    let filePath: string | undefined;
    const toolName = payload.name;
    // Claude: Write/Edit (file_path), Gemini: write_file/edit_file (file_path or path),
    // Codex: file_edit (path), Pi: write/edit (path), OpenCode: apply_patch (check patchText)
    const FILE_TOOLS = new Set(["Write", "Edit", "write_file", "edit_file", "file_edit", "write", "edit"]);
    if (FILE_TOOLS.has(toolName ?? "") && payload.input) {
      sawFileTools = true;
      filePath = (payload.input.file_path ?? payload.input.filePath ?? payload.input.path) as string | undefined;
    } else if (toolName === "Bash" || toolName === "bash") {
      sawBash = true;
    } else if (toolName === "apply_patch" && payload.input) {
      sawFileTools = true;
      // OpenCode apply_patch: extract path from patchText "*** Add File: /path" or "*** Update File: /path"
      const patch = payload.input.patchText as string | undefined;
      const match = patch?.match(/\*\*\* (?:Add|Update) File: (.+)/);
      if (match) filePath = match[1].trim();
    }

    if (!filePath || typeof filePath !== "string" || filePath === "") continue;
    // Resolve relative paths: keep as-is with leading / (the container CWD
    // varies by backend — Codex uses /, Claude uses /home/user, etc.)
    const resolved = filePath.startsWith("/") ? filePath : `/${filePath}`;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    paths.push(resolved);
  }

  return { paths, sawFileTools, sawBash };
}

/**
 * Validate a container file path for safety.
 *   - Must start with `/`
 *   - Must not contain `..`
 *   - Must not be in a blocked system directory
 */
function isPathSafe(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (p.includes("..")) return false;
  return !BLOCKED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Check whether a file path has a known binary extension.
 */
function isBinaryExtension(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Fallback file discovery: find recently modified files on the container.
 * Uses `find -newer /proc/1/cmdline` to detect files changed since container start,
 * then filters to common code/text directories.
 */
async function discoverChangedFiles(
  sandboxName: string,
  provider: ContainerProvider,
  secrets?: ProviderSecrets,
): Promise<string[]> {
  try {
    // Find user-created files in common writable dirs.
    // Use -mmin -30 (modified in last 30 min) as a portable heuristic
    // since /proc/1/cmdline doesn't exist on macOS containers.
    const result = await provider.exec(
      sandboxName,
      ["sh", "-c", [
        "find /home /root /workspace /mnt /tmp",
        "-maxdepth 4 -type f -mmin -30 -size +0c",
        "! -path '*/.git/*' ! -path '*/node_modules/*' ! -path '*/.npm/*'",
        "! -path '*/.config/*' ! -path '*/.local/*' ! -path '*/.cache/*'",
        "! -path '*/cache/*' ! -path '*-debug-*.log'",
        "! -name '.*' ! -name '*.sqlite' ! -name '*.sqlite-*'",
        "! -name 'installation_id' ! -name 'plugins.sha'",
        "2>/dev/null | head -30",
      ].join(" ")],
      { secrets, timeoutMs: 10000 },
    );
    if (result.exit_code !== 0 || !result.stdout.trim()) return [];
    return result.stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Sync modified files from a container back to the gateway file store.
 *
 * Called by the turn driver between `bumpSessionStats()` and
 * `emit("session.status_idle", ...)` so the container is still alive.
 */
export async function syncContainerFiles(opts: {
  sessionId: string;
  sandboxName: string;
  provider: ContainerProvider;
  secrets?: ProviderSecrets;
}): Promise<{ synced: number; skipped: number }> {
  const { sessionId, sandboxName, provider, secrets } = opts;

  const extracted = extractFilePaths(sessionId);
  let allPaths = extracted.paths;

  // Fallback: discover changed files on the container when:
  // 1. File tools were used but paths were empty (Codex v0.120+ bug)
  // 2. Bash tool was used (scripts may produce output files like .docx)
  // Merges discovered files with any explicitly tracked paths.
  if (extracted.sawFileTools || extracted.sawBash) {
    const discovered = await discoverChangedFiles(sandboxName, provider, secrets);
    for (const p of discovered) {
      if (!allPaths.includes(p)) allPaths.push(p);
    }
  }
  if (allPaths.length === 0) return { synced: 0, skipped: 0 };

  // Filter paths
  const validPaths: string[] = [];
  let skipped = 0;

  for (const p of allPaths) {
    if (!isPathSafe(p)) {
      skipped++;
      continue;
    }
    if (isBinaryExtension(p)) {
      skipped++;
      continue;
    }
    validPaths.push(p);
  }

  if (validPaths.length === 0) return { synced: 0, skipped };

  // Cap at MAX_FILES_PER_SYNC
  if (validPaths.length > MAX_FILES_PER_SYNC) {
    console.warn(
      `[container-file-sync] ${sessionId}: ${validPaths.length} files to sync, capping at ${MAX_FILES_PER_SYNC}`,
    );
    skipped += validPaths.length - MAX_FILES_PER_SYNC;
    validPaths.length = MAX_FILES_PER_SYNC;
  }

  let synced = 0;

  // Extensions that must be read as binary (base64) to avoid corruption.
  const BINARY_READ_EXTS = new Set([
    ".docx", ".xlsx", ".pptx", ".pdf", ".zip", ".tar", ".gz",
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ]);

  for (const filePath of validPaths) {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const isBinary = BINARY_READ_EXTS.has(ext);

      const result = isBinary
        ? await provider.exec(sandboxName, ["base64", "-w", "0", "--", filePath], { secrets, timeoutMs: 15000 })
        : await provider.exec(sandboxName, ["cat", "--", filePath], { secrets, timeoutMs: 15000 });

      if (result.exit_code !== 0 || !result.stdout) {
        skipped++;
        continue;
      }

      // Strip sprites control chars from output
      const raw = result.stdout.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

      const data = isBinary ? Buffer.from(raw.trim(), "base64") : Buffer.from(raw, "utf8");

      // Size check
      if (data.length > MAX_FILE_SIZE) {
        skipped++;
        continue;
      }

      // Compute SHA-256 hash
      const hash = createHash("sha256").update(data).digest("hex");

      // Dedup check
      const existing = findFileByContainerPath(sessionId, filePath, hash);
      if (existing) {
        skipped++;
        continue;
      }

      // Store on disk
      const fileId = newId("file");
      const filename = path.basename(filePath);
      const storagePath = storeFile(fileId, filename, data);

      // Determine content type from extension
      const fileExt = path.extname(filename).toLowerCase();
      const contentType = MIME_MAP[fileExt] ?? "text/plain";

      // Insert DB row
      createFile({
        filename,
        size: data.length,
        content_type: contentType,
        storage_path: storagePath,
        scope: { type: "session", id: sessionId },
        container_path: filePath,
        content_hash: hash,
      });

      synced++;
    } catch (err) {
      console.warn(`[container-file-sync] failed to sync ${filePath}:`, err);
      skipped++;
    }
  }

  return { synced, skipped };
}

/** Simple extension-to-MIME map for common code/config file types. */
const MIME_MAP: Record<string, string> = {
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".md": "text/markdown",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".java": "text/x-java",
  ".rb": "text/x-ruby",
  ".sh": "text/x-shellscript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".xml": "text/xml",
  ".sql": "text/x-sql",
  ".txt": "text/plain",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
};
