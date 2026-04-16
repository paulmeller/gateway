/**
 * Supported models per backend engine.
 *
 * Used to validate that `agent.model` is compatible with `agent.engine`
 * at agent creation time. Prevents users from creating agents like
 * `{engine: "claude", model: "gpt-5.4"}` that would fail at runtime.
 */

export const MODELS: Record<string, string[]> = {
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

export function isValidModelForEngine(engine: string, model: string): boolean {
  const allowed = MODELS[engine];
  if (!allowed) return true; // Unknown engine — defer to backend validation
  return allowed.includes(model);
}
