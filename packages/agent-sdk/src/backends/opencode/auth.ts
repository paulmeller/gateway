/**
 * Auth env + create-time validation for the opencode backend.
 *
 * Opencode is multi-provider: it reads `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * and other provider-specific env vars at startup and routes model calls
 * based on the `provider/model` prefix in the `--model` flag. We forward
 * every provider key we know about; opencode picks the right one based on
 * the agent's model.
 *
 * Opencode refuses `sk-ant-oat*` OAuth tokens per Anthropic ToS. See
 * 
 * — opencode provider only forwards `ANTHROPIC_API_KEY`
 * and warns on OAuth tokens. We enforce the "at least one provider key"
 * invariant at agent create time (and belt-and-braces at first turn) so
 * the user doesn't discover the mismatch inside an opaque opencode error
 * stream.
 *
 * Spike (2026-04-10) verified on a real sprite that opencode picks
 * up `OPENAI_API_KEY` as an env var without any config file.
 */
import { getConfig } from "../../config";

export function buildOpencodeAuthEnv(): Record<string, string> {
  const cfg = getConfig();
  const env: Record<string, string> = {};
  if (cfg.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
  }
  if (cfg.openAiApiKey) {
    env.OPENAI_API_KEY = cfg.openAiApiKey;
  }
  if (cfg.claudeToken && !cfg.anthropicApiKey) {
    console.warn(
      "[opencode] CLAUDE_CODE_OAUTH_TOKEN cannot drive opencode — set ANTHROPIC_API_KEY",
    );
  }
  return env;
}

/**
 * Returns null if opencode can run with the current config, or an error
 * message if it can't. Used both at agent create time (`validateAgentCreation`
 * hook) and at first-turn time (`validateRuntime` hook).
 *
 * Opencode is multi-provider so we accept either a valid Anthropic key or
 * an OpenAI key. The agent's `model` field is still `provider/model` shaped
 * (e.g. `openai/gpt-4o-mini`) and opencode routes based on the prefix.
 */
export function validateOpencodeRuntime(): string | null {
  const cfg = getConfig();
  if (cfg.anthropicApiKey || cfg.openAiApiKey) return null;
  return "opencode backend requires at least one provider key: ANTHROPIC_API_KEY or OPENAI_API_KEY (opencode does not accept sk-ant-oat OAuth tokens per Anthropic ToS)";
}
