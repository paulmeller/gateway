/**
 * Auth env + create-time validation for the pi backend.
 *
 * pi.dev is provider-agnostic — it can drive Anthropic, OpenAI, Google,
 * Groq, OpenRouter and others. Which key it needs depends on the agent's
 * `model` (and on its own `--provider` flag). To keep the integration
 * simple we forward whichever LLM keys are configured in the gateway and
 * let pi pick the right one based on its own model resolution.
 *
 * At minimum one of ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY
 * must be present, otherwise pi has no way to authenticate.
 */
import { getConfig } from "../../config";

export function buildPiAuthEnv(): Record<string, string> {
  const cfg = getConfig();
  const env: Record<string, string> = {};
  if (cfg.anthropicApiKey) env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
  if (cfg.openAiApiKey) env.OPENAI_API_KEY = cfg.openAiApiKey;
  if (cfg.geminiApiKey) env.GEMINI_API_KEY = cfg.geminiApiKey;
  return env;
}

/**
 * Returns null if pi can run, or an error message if it can't. Used at
 * agent create time (validateAgentCreation) and first-turn time
 * (validateRuntime).
 */
export function validatePiRuntime(): string | null {
  const cfg = getConfig();
  if (!cfg.anthropicApiKey && !cfg.openAiApiKey && !cfg.geminiApiKey) {
    return "pi backend requires at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY to be set";
  }
  return null;
}
