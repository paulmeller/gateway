/**
 * Vault value encryption at rest.
 *
 * Uses AES-256-GCM with a per-instance key from VAULT_ENCRYPTION_KEY.
 * If not set, auto-generates a key and writes it to .env (same pattern
 * as SEED_API_KEY). Losing the key means losing all vault contents —
 * back up your .env file.
 *
 * Ciphertext format (base64): iv(12) + tag(16) + ciphertext(n)
 * Values prefixed with "enc:v1:" are encrypted; others are plaintext
 * (for backwards compat — re-encrypted on next write).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION_PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;

/** Find the closest existing .env — walks up from CWD, falls back to CWD. */
function findEnvPath(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), ".env");
}

function loadOrGenerateKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.VAULT_ENCRYPTION_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "hex");
    if (key.length !== KEY_LEN) {
      throw new Error(`VAULT_ENCRYPTION_KEY must be ${KEY_LEN * 2} hex chars (${KEY_LEN} bytes)`);
    }
    cachedKey = key;
    return key;
  }

  // VAULT_ENCRYPTION_KEY_FILE: an on-disk path to the hex key. Preferred
  // for container deployments where .env lives outside the persistent
  // volume. If the file exists, read it. If not, generate and write it.
  const keyFile = process.env.VAULT_ENCRYPTION_KEY_FILE;
  if (keyFile) {
    try {
      if (fs.existsSync(keyFile)) {
        const hex = fs.readFileSync(keyFile, "utf-8").trim();
        const key = Buffer.from(hex, "hex");
        if (key.length !== KEY_LEN) {
          throw new Error(`${keyFile} must contain ${KEY_LEN * 2} hex chars`);
        }
        process.env.VAULT_ENCRYPTION_KEY = hex;
        cachedKey = key;
        return key;
      }
      // Generate and write. mode 0600 = owner read/write only.
      const newKey = crypto.randomBytes(KEY_LEN);
      const hex = newKey.toString("hex");
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, hex, { mode: 0o600 });
      console.log(`[vault] generated VAULT_ENCRYPTION_KEY and wrote to ${keyFile}`);
      console.warn(`[vault] BACK UP ${keyFile} — losing this key makes vault entries unrecoverable`);
      process.env.VAULT_ENCRYPTION_KEY = hex;
      cachedKey = newKey;
      return newKey;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[vault] Cannot read/write VAULT_ENCRYPTION_KEY_FILE (${keyFile}): ${msg}`);
    }
  }

  // Auto-generate and persist to .env so it survives restarts.
  // Walk up from CWD to find an existing .env (monorepo root), or fall
  // back to CWD for single-package setups.
  const newKey = crypto.randomBytes(KEY_LEN);
  const hex = newKey.toString("hex");
  const envPath = findEnvPath();
  try {
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, `VAULT_ENCRYPTION_KEY=${hex}\n`, "utf-8");
    } else {
      fs.appendFileSync(envPath, `\nVAULT_ENCRYPTION_KEY=${hex}\n`, "utf-8");
    }
    console.log(`[vault] generated VAULT_ENCRYPTION_KEY and wrote to ${envPath}`);
    console.warn(`[vault] BACK UP YOUR .env — losing this key will make all vault entries unrecoverable`);
  } catch (err) {
    // Can't write .env — refuse to encrypt rather than silently using an
    // ephemeral key that would make vault entries unrecoverable on restart.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[vault] Cannot write VAULT_ENCRYPTION_KEY to ${envPath}: ${msg}\n` +
      `Set VAULT_ENCRYPTION_KEY manually in your environment, or use\n` +
      `VAULT_ENCRYPTION_KEY_FILE=<path> to point at a persistent on-disk key file.\n` +
      `  VAULT_ENCRYPTION_KEY=${hex}\n` +
      `Without a persistent key, vault entries would be unrecoverable on restart.`,
    );
  }
  process.env.VAULT_ENCRYPTION_KEY = hex;
  cachedKey = newKey;
  return newKey;
}

export function encryptValue(plaintext: string): string {
  const key = loadOrGenerateKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, tag, encrypted]);
  return VERSION_PREFIX + combined.toString("base64");
}

export function decryptValue(stored: string): string {
  // Backwards-compat: un-prefixed values are plaintext
  if (!stored.startsWith(VERSION_PREFIX)) return stored;

  const key = loadOrGenerateKey();
  const combined = Buffer.from(stored.slice(VERSION_PREFIX.length), "base64");
  const iv = combined.subarray(0, IV_LEN);
  const tag = combined.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = combined.subarray(IV_LEN + TAG_LEN);

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
