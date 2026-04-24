/**
 * Static fallback models, used as default selections before the dynamic
 * model registry (useModels hook / GET /v1/models) responds.
 *
 * For live model data, use the `useModels()` hook from `@/hooks/use-models`.
 */
export const FALLBACK_MODELS: Record<string, string[]> = {
  claude: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  opencode: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6", "openai/gpt-5.4", "openai/gpt-5.4-mini"],
  codex: ["gpt-5.4-mini", "gpt-5.4", "gpt-5.3-codex"],
  gemini: ["gemini-3.1-pro-preview", "gemini-3.1-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
  factory: ["claude-sonnet-4-6", "claude-opus-4-6", "gpt-5.4", "gemini-3.1-pro-preview"],
  pi: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6", "openai/gpt-5.4", "google/gemini-2.5-flash"],
};

/** @deprecated Use FALLBACK_MODELS instead. Kept for backward compatibility. */
export const MODELS = FALLBACK_MODELS;

export const ENGINES = Object.keys(FALLBACK_MODELS);

export const LOCAL_PROVIDERS = ["docker", "apple-container", "podman"] as const;
export const CLOUD_PROVIDERS = ["anthropic", "sprites", "e2b", "vercel", "daytona", "fly", "modal"] as const;
export const PROVIDERS = [...LOCAL_PROVIDERS, ...CLOUD_PROVIDERS] as const;

export const PROVIDER_TOKENS: Record<string, { key: string; label: string; placeholder: string }> = {
  anthropic: { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", placeholder: "sk-ant-..." },
  sprites: { key: "SPRITE_TOKEN", label: "Sprites.dev Token", placeholder: "user/org/.../token" },
  e2b: { key: "E2B_API_KEY", label: "E2B API Key", placeholder: "e2b_..." },
  vercel: { key: "VERCEL_TOKEN", label: "Vercel Token", placeholder: "..." },
  daytona: { key: "DAYTONA_API_KEY", label: "Daytona API Key", placeholder: "..." },
  fly: { key: "FLY_API_TOKEN", label: "Fly.io API Token", placeholder: "fo1_..." },
  modal: { key: "MODAL_TOKEN_ID", label: "Modal Token ID", placeholder: "..." },
};

export const ENGINE_KEYS: Record<string, { key: string; label: string }> = {
  claude: { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key or OAuth Token" },
  codex: { key: "OPENAI_API_KEY", label: "OpenAI API Key" },
  gemini: { key: "GEMINI_API_KEY", label: "Gemini API Key" },
  factory: { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key" },
  pi: { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key" },
};

/** Detect whether a model is a local Ollama model (no API key needed). */
export function isLocalModel(model: string): boolean {
  if (model.includes("/")) return false;
  const cloudPrefixes = ["claude-", "gpt-", "o1-", "o3-", "o4-", "codex-", "chatgpt-", "gemini-"];
  return !cloudPrefixes.some(p => model.startsWith(p));
}

/** OpenCode and pi support multiple providers — key depends on the model prefix */
export function getEngineKey(engine: string, model: string): { key: string; label: string } | undefined {
  // Local Ollama models don't need API keys
  if (isLocalModel(model)) return undefined;

  if (engine === "opencode" || engine === "pi") {
    if (model.startsWith("openai/")) return { key: "OPENAI_API_KEY", label: "OpenAI API Key" };
    if (model.startsWith("google/") || model.startsWith("gemini/")) {
      return { key: "GEMINI_API_KEY", label: "Gemini API Key" };
    }
    return { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key" };
  }
  return ENGINE_KEYS[engine];
}
