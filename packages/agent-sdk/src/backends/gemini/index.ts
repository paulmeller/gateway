/**
 * Gemini backend: drives Google's `gemini -p` on sprites.dev containers.
 *
 * Gemini CLI uses `-p` for prompt mode (like claude) and accepts the prompt
 * on stdin. The wrapper script reads env vars then pipes remaining stdin to
 * gemini.
 *
 * Custom tool re-entry is NOT supported by gemini — gemini has no equivalent
 * of claude's --input-format stream-json. buildTurn rejects
 * toolResults.length > 0 with an invalid_request_error.
 */
import { ApiError } from "../../errors";
import type { Backend, BuildTurnInput, BuildTurnResult } from "../types";
import type { TranslatorOptions } from "../shared/translator-types";
import { wrapPromptWithSystem } from "../shared/wrap-prompt";
import { buildGeminiArgs } from "./args";
import { buildGeminiAuthEnv, validateGeminiRuntime } from "./auth";
import { createGeminiTranslator } from "./translator";
import { GEMINI_WRAPPER_PATH } from "./wrapper-script";
import { prepareGeminiOnSprite } from "./setup";

function buildTurn(input: BuildTurnInput): BuildTurnResult {
  const { agent, backendSessionId, promptText, toolResults } = input;
  if (toolResults.length > 0) {
    throw new ApiError(
      400,
      "invalid_request_error",
      "gemini backend does not support user.custom_tool_result re-entry in v1",
    );
  }
  const wrappedPrompt = wrapPromptWithSystem(promptText, agent.system, agent.skills);
  const argv = buildGeminiArgs({ agent, backendSessionId, prompt: wrappedPrompt });
  const env = buildGeminiAuthEnv();
  // Gemini --prompt takes the text as an arg value, not stdin
  return { argv, env, stdin: "" };
}

export const geminiBackend: Backend = {
  name: "gemini" as Backend["name"],
  wrapperPath: GEMINI_WRAPPER_PATH,
  buildTurn,
  createTranslator: (opts: TranslatorOptions) => createGeminiTranslator(opts),
  prepareOnSprite: (name, provider) => prepareGeminiOnSprite(name, provider),

  validateRuntime: validateGeminiRuntime,
};

export {
  buildGeminiArgs,
  buildGeminiAuthEnv,
  createGeminiTranslator,
  prepareGeminiOnSprite,
  GEMINI_WRAPPER_PATH,
};
