/**
 * Fallback models per backend engine.
 *
 * Used as a static fallback when the dynamic model registry has no
 * live or stale data. Also used for basic engine-model compatibility
 * checks when the registry is not yet warmed.
 *
 * The dynamic model registry (lib/model-registry.ts) is the primary
 * source; these are the safety net.
 */

export const FALLBACK_MODELS: Record<string, string[]> = {
  claude: [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5",
  ],
  opencode: [
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
  ],
  codex: [
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5.3-codex",
    "codex-mini-latest",
    "codex-latest",
  ],
  gemini: [
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-pro",
  ],
  factory: [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "gpt-5.4",
    "gemini-3.1-pro-preview",
  ],
  pi: [
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
    "openai/gpt-5.4",
    "google/gemini-2.5-flash",
  ],
};

/** @deprecated Use FALLBACK_MODELS instead. Kept for backward compatibility. */
export const MODELS = FALLBACK_MODELS;

/**
 * Check whether a model is valid for a given engine.
 *
 * 1. Check the static FALLBACK_MODELS (fast, synchronous).
 * 2. If not found, reject obvious engine-model mismatches
 *    (e.g. gemini engine + claude-* model).
 * 3. Otherwise return true — let the runtime validate.
 *
 * The dynamic model registry is async and cannot be used here
 * synchronously. Agent creation handlers should call getModels()
 * for a more complete check when they need it.
 */
export function isValidModelForEngine(engine: string, model: string): boolean {
  const allowed = FALLBACK_MODELS[engine];
  if (!allowed) return true; // Unknown engine — defer to backend validation

  // Direct match against fallback list
  if (allowed.includes(model)) return true;

  // Reject obvious cross-provider mismatches
  const engineProviderMap: Record<string, string[]> = {
    claude: ["claude-"],
    gemini: ["gemini-"],
    codex: ["gpt-", "o1-", "o3-", "o4-", "codex-", "chatgpt-"],
  };
  const requiredPrefixes = engineProviderMap[engine];
  if (requiredPrefixes) {
    const modelBase = model.replace(/^(anthropic|openai|google)\//, "");
    const matchesAny = requiredPrefixes.some((p) => modelBase.startsWith(p));
    if (!matchesAny) return false;
  }

  // Unknown model but not an obvious mismatch — allow through
  // (let the runtime validate against the actual provider)
  return true;
}
