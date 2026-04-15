/**
 * PII / secret redaction for event payloads.
 *
 * Runs at the `appendEvent` / `appendEventsBatch` boundary in `sessions/bus.ts`
 * via `installPayloadRedactor`. Every event is passed through this redactor
 * before being serialized to JSON and inserted into the events table — no
 * writer can bypass it.
 *
 * ## What gets redacted
 *
 *   1. Known config tokens from the cascade — `ANTHROPIC_API_KEY`,
 *      `OPENAI_API_KEY`, `GEMINI_API_KEY`, `FACTORY_API_KEY`,
 *      `CLAUDE_CODE_OAUTH_TOKEN`, `SPRITE_TOKEN`. These have high leak
 *      risk because the wrapper scripts inject them into env lines that
 *      sometimes end up echoed by tools.
 *
 *   2. Substrings listed in `OBS_REDACT_KEYS` (comma-separated env-var
 *      names). Their values are looked up in `process.env` at redaction
 *      time. Use this to scrub custom secrets baked into a deployment.
 *
 *   3. Vault entry values for the currently-running session — these are
 *      user-scoped secrets that should NEVER appear in a trace.
 *
 * Secrets too short to be meaningful (< 4 chars) are skipped to avoid
 * nuking common short words.
 *
 * ## What this is NOT
 *
 *   - Not a prompt-injection detector. That's an eval-time concern.
 *   - Not a structured-field blocklist. Event payload shapes vary per
 *     backend; a value-based substring redactor catches secrets wherever
 *     they end up in the JSON tree.
 *   - Not a replacement for `resolve-secrets.BLOCKED_ENV_KEYS` — that's
 *     the write-side guard for env injection. This is the read-side
 *     guard for event payloads.
 */
import { getConfig } from "../config";
import type { AppendInput } from "../db/events";
import { listEntries as listVaultEntries } from "../db/vaults";

const REDACTED = "[REDACTED]";
const MIN_SECRET_LEN = 4;

/**
 * Collect every secret string that should be scrubbed from event payloads
 * on this process. Pulls from config + listed env-var names + any vault
 * entries reachable from the global vault table.
 *
 * Note: vault entries are scoped to sessions at write time, but at
 * redaction time we don't have the session handy (the redactor runs on
 * an opaque AppendInput). We over-redact by collecting ALL vault values
 * seen in this boot — a false-positive in trace data is cheaper than a
 * false-negative (leaked secret).
 */
function collectSecrets(): string[] {
  const cfg = getConfig();
  const secrets: string[] = [];
  const push = (v: string | undefined) => {
    if (v && v.length >= MIN_SECRET_LEN) secrets.push(v);
  };

  push(cfg.anthropicApiKey);
  push(cfg.claudeToken);
  push(cfg.openAiApiKey);
  push(cfg.geminiApiKey);
  push(cfg.factoryApiKey);
  push(cfg.spriteToken);

  for (const key of cfg.redactEnvKeys) {
    push(process.env[key]);
  }

  // Secret collection is cached at the module level for the process
  // lifetime. Vault secrets may change mid-process; we re-read them
  // every time via the exported helper below to avoid staleness.
  return secrets;
}

let cachedProcessSecrets: string[] | null = null;
function getProcessSecrets(): string[] {
  if (cachedProcessSecrets == null) {
    cachedProcessSecrets = collectSecrets();
  }
  return cachedProcessSecrets;
}

/**
 * Force the cached secrets list to refresh on next redaction. Call after
 * writing a new API key to settings.
 */
export function invalidateRedactorCache(): void {
  cachedProcessSecrets = null;
}

/**
 * Extra vault entries — seeded by the process when a session with
 * vaults runs. The set grows monotonically; it's an over-approximation
 * that favors safety over completeness.
 */
const vaultSecrets = new Set<string>();

/**
 * Scrub vault entries for a specific vault into the redactor. Called
 * from the driver when it resolves a session's vaults so values that
 * show up later in tool outputs get masked. Called from tests to pre-
 * seed the set without running a full session.
 */
export function seedVaultSecrets(vaultId: string): void {
  try {
    const entries = listVaultEntries(vaultId);
    for (const e of entries) {
      if (e.value && e.value.length >= MIN_SECRET_LEN) vaultSecrets.add(e.value);
    }
  } catch {
    /* best-effort */
  }
}

/** Exposed for tests: clears the accumulated vault-secrets set. */
export function resetVaultSecrets(): void {
  vaultSecrets.clear();
}

/**
 * Scrub every occurrence of any known secret from a JSON-serializable
 * value. Walks the tree and does substring replacement on strings.
 * Pure — returns a new value; never mutates the input.
 */
function scrub(value: unknown, secrets: string[]): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    let out = value;
    for (const s of secrets) {
      // Cheap guard: only do the replace if the substring is present.
      if (out.includes(s)) {
        out = out.split(s).join(REDACTED);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, secrets));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrub(v, secrets);
    }
    return out;
  }
  return value;
}

/**
 * The `AppendInput` redactor that `bus.ts` installs at boot. Returns a
 * new input with `payload` scrubbed of every known secret substring.
 */
export function redactAppendInput(input: AppendInput): AppendInput {
  const secrets = [...getProcessSecrets(), ...vaultSecrets];
  if (secrets.length === 0) return input;
  const scrubbedPayload = scrub(input.payload, secrets) as Record<string, unknown>;
  if (scrubbedPayload === input.payload) return input;
  return { ...input, payload: scrubbedPayload };
}
