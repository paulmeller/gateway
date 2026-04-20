/**
 * .env file manipulation helpers — safe read/write without duplicates.
 *
 * These exist because `init.ts` and `vault-crypto.ts` may run before
 * dotenv has loaded the `.env` file into `process.env`. Without reading
 * `.env` directly, they'd generate new values and blindly append —
 * creating duplicate lines where dotenv's last-wins behavior silently
 * picks the wrong key (catastrophic for VAULT_ENCRYPTION_KEY).
 *
 * Write operations use atomic rename (write to .tmp, rename to .env)
 * to prevent partial-write corruption on crash.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Read a single key's value directly from a .env file, bypassing
 * `process.env`. Returns undefined if the file doesn't exist or the
 * key isn't present. When duplicates exist, returns the last value
 * (matching dotenv's last-wins semantics).
 *
 * Handles: `KEY=value`, `export KEY=value`, `KEY="value"`, `KEY='value'`
 * Ignores: `# KEY=value` (comments)
 */
export function readEnvValue(envPath: string, key: string): string | undefined {
  if (!fs.existsSync(envPath)) return undefined;

  const content = fs.readFileSync(envPath, "utf-8");
  const re = new RegExp(`^(?:export\\s+)?${escapeRegex(key)}=(.*)$`, "gm");
  let last: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    let val = match[1].trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    last = val;
  }
  return last;
}

/**
 * Write a key=value to .env. If the key already exists, replaces the
 * line in-place. If it doesn't, appends. Creates the file if needed.
 *
 * Use for SEED_API_KEY — replacing a just-generated key is safe.
 * Do NOT use for VAULT_ENCRYPTION_KEY — use `ensureEnvLine` instead.
 */
export function upsertEnvLine(envPath: string, key: string, value: string): void {
  const line = `${key}=${value}`;

  if (!fs.existsSync(envPath)) {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, `${line}\n`, "utf-8");
    return;
  }

  const content = fs.readFileSync(envPath, "utf-8");
  const re = new RegExp(`^(?:export\\s+)?${escapeRegex(key)}=.*$`, "m");

  let updated: string;
  if (re.test(content)) {
    // Replace first match, remove duplicates
    updated = content.replace(re, line);
    let seen = false;
    updated = updated.split("\n").filter((l) => {
      if (re.test(l)) {
        if (seen) return false;
        seen = true;
      }
      return true;
    }).join("\n");
  } else {
    // Append
    updated = content.trimEnd() + `\n${line}`;
  }

  // Normalize: ensure exactly one trailing newline
  updated = updated.trimEnd() + "\n";
  atomicWrite(envPath, updated);
}

/**
 * Write a key=value to .env ONLY if the key doesn't already exist.
 * No-op if the key is present (even with a different value).
 *
 * Use for VAULT_ENCRYPTION_KEY — replacing an existing key would
 * make all encrypted vault entries permanently unrecoverable.
 */
export function ensureEnvLine(envPath: string, key: string, value: string): void {
  // Check if key already exists in the file
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    const re = new RegExp(`^(?:export\\s+)?${escapeRegex(key)}=`, "m");
    if (re.test(content)) return; // already present — do NOT overwrite
  }

  // Key doesn't exist — safe to write
  upsertEnvLine(envPath, key, value);
}

/**
 * Scan a .env file for duplicate keys. Returns an array of key names
 * that appear more than once. Used by the boot-time health check.
 */
export function findDuplicateKeys(envPath: string): string[] {
  if (!fs.existsSync(envPath)) return [];
  const content = fs.readFileSync(envPath, "utf-8");
  const counts = new Map<string, number>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
    if (match) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
}

// ── Internal helpers ──────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Atomic write: write to .tmp then rename. Prevents partial writes on crash. */
function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}
