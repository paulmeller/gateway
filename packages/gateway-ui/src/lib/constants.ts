export const MODELS: Record<string, string[]> = {
  claude: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  opencode: ["anthropic/claude-sonnet-4-6", "openai/gpt-4o-mini"],
  codex: ["gpt-5.4-mini", "gpt-5.4"],
  gemini: ["gemini-3.1-pro-preview", "gemini-3", "gemini-2.5-flash"],
  factory: ["claude-sonnet-4-6", "gpt-5.4", "gemini-3.1-pro-preview"],
};

export const ENGINES = Object.keys(MODELS);

export const PROVIDERS = [
  "docker",
  "apple-container",
  "apple-firecracker",
  "podman",
  "sprites",
  "e2b",
  "vercel",
  "daytona",
  "fly",
  "modal",
] as const;

export const PROVIDER_TOKENS: Record<string, { key: string; label: string; placeholder: string }> = {
  sprites: { key: "SPRITE_TOKEN", label: "Sprites.dev Token", placeholder: "user/org/.../token" },
  e2b: { key: "E2B_API_KEY", label: "E2B API Key", placeholder: "e2b_..." },
  vercel: { key: "VERCEL_TOKEN", label: "Vercel Token", placeholder: "..." },
  daytona: { key: "DAYTONA_API_KEY", label: "Daytona API Key", placeholder: "..." },
  fly: { key: "FLY_API_TOKEN", label: "Fly.io API Token", placeholder: "fo1_..." },
  modal: { key: "MODAL_TOKEN_ID", label: "Modal Token ID", placeholder: "..." },
};

export const ENGINE_KEYS: Record<string, { key: string; label: string }> = {
  claude: { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key" },
  opencode: { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key" },
  codex: { key: "OPENAI_API_KEY", label: "OpenAI API Key" },
  gemini: { key: "GEMINI_API_KEY", label: "Gemini API Key" },
  factory: { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key" },
};
