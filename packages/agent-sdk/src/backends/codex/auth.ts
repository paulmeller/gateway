/**
 * Auth env + create-time validation for the codex backend.
 *
 * Codex accepts both CODEX_API_KEY and OPENAI_API_KEY. We forward both,
 * setting them to the same value (our config.openAiApiKey) for belt-and-
 * braces. Rejects sk-ant-* tokens explicitly
 * (cli-providers.ts:242-244).
 *
 * will verify which env var codex actually prefers on the current
 * v0.118.0 release.
 */
import { getConfig } from "../../config";

export function buildCodexAuthEnv(): Record<string, string> {
  const cfg = getConfig();
  const env: Record<string, string> = {};
  if (cfg.openAiApiKey) {
    env.OPENAI_API_KEY = cfg.openAiApiKey;
    env.CODEX_API_KEY = cfg.openAiApiKey;
  }
  return env;
}

/**
 * Returns null if codex can run, or an error message if it can't. Used at
 * agent create time (validateAgentCreation) and first-turn time
 * (validateRuntime).
 */
export function validateCodexRuntime(): string | null {
  const cfg = getConfig();
  if (!cfg.openAiApiKey) {
    return "codex backend requires OPENAI_API_KEY to be set";
  }
  return null;
}
