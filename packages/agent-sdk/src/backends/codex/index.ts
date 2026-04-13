/**
 * Codex backend: drives OpenAI's `codex exec` on sprites.dev containers.
 *
 * Ported from
 * 
 * (the  codex provider), adapted for our sprite-only
 * execution model. Opencompletions only ran codex in its local backend;
 * this adapter is the first time codex runs inside a sprites.dev sprite,
 * so the wrapper script + install flow mirror the opencode adapter's
 * sprite-side patterns.
 *
 * Custom tool re-entry is NOT supported by codex — codex exec has no
 * equivalent of claude's --input-format stream-json. buildTurn rejects
 * toolResults.length > 0 with an invalid_request_error.
 */
import { ApiError } from "../../errors";
import type { Backend, BuildTurnInput, BuildTurnResult } from "../types";
import type { TranslatorOptions } from "../shared/translator-types";
import { wrapPromptWithSystem } from "../shared/wrap-prompt";
import { buildCodexArgs } from "./args";
import { buildCodexAuthEnv, validateCodexRuntime } from "./auth";
import { createCodexTranslator } from "./translator";
import { CODEX_WRAPPER_PATH } from "./wrapper-script";
import { prepareCodexOnSprite } from "./setup";

function buildTurn(input: BuildTurnInput): BuildTurnResult {
  const { agent, promptText, toolResults } = input;
  if (toolResults.length > 0) {
    throw new ApiError(
      400,
      "invalid_request_error",
      "codex backend does not support user.custom_tool_result re-entry in v1",
    );
  }
  const argv = buildCodexArgs({ agent });
  const env = buildCodexAuthEnv();
  const wrappedPrompt = wrapPromptWithSystem(promptText, agent.system);
  return { argv, env, stdin: wrappedPrompt };
}

export const codexBackend: Backend = {
  name: "codex",
  wrapperPath: CODEX_WRAPPER_PATH,
  buildTurn,
  createTranslator: (opts: TranslatorOptions) => createCodexTranslator(opts),
  prepareOnSprite: (name, provider) => prepareCodexOnSprite(name, provider),

  validateRuntime: validateCodexRuntime,
};

export {
  buildCodexArgs,
  buildCodexAuthEnv,
  createCodexTranslator,
  prepareCodexOnSprite,
  CODEX_WRAPPER_PATH,
};
