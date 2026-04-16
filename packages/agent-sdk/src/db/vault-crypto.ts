/**
 * Vault value encryption at rest.
 *
 * Uses AES-256-GCM with a per-instance key derived from:
 *   1. VAULT_ENCRYPTION_KEY env var (hex-encoded 32 bytes), or
 *   2. A generated key persisted in the `settings` table
 *
 * Ciphertext format (base64): version(1) + iv(12) + tag(16) + ciphertext(n)
 * Values prefixed with "enc:v1:" are encrypted; others are plaintext
 * (for backwards compat with pre-encryption values — they're re-encrypted
 * on next write).
 */
import crypto from "crypto";
import { getDb } from "./client";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION_PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;

function loadOrGenerateKey(): Buffer {
  if (cachedKey) return cachedKey;

  // 1. Env var takes precedence
  const fromEnv = process.env.VAULT_ENCRYPTION_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "hex");
    if (key.length !== KEY_LEN) {
      throw new Error(`VAULT_ENCRYPTION_KEY must be ${KEY_LEN * 2} hex chars (${KEY_LEN} bytes)`);
    }
    cachedKey = key;
    return key;
  }

  // 2. Persist a generated key in settings table
  const db = getDb();
  const existing = db
    .prepare(`SELECT value FROM settings WHERE key = 'vault_encryption_key'`)
    .get() as { value: string } | undefined;

  if (existing) {
    cachedKey = Buffer.from(existing.value, "hex");
    return cachedKey;
  }

  const newKey = crypto.randomBytes(KEY_LEN);
  db.prepare(
    `INSERT INTO settings (key, value, type, updated_at) VALUES (?, ?, 'secret', ?)`,
  ).run("vault_encryption_key", newKey.toString("hex"), Date.now());
  cachedKey = newKey;
  console.log("[vault] generated new encryption key and stored in settings");
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
