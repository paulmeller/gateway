/**
 * pi backend: drives the pi.dev coding agent (`pi --mode json`) on
 * sprites.dev containers.
 *
 * pi is a minimal, provider-agnostic terminal coding agent
 * (https://shittycodingagent.ai/, npm: @mariozechner/pi-coding-agent).
 * It exposes a `--mode json` newline-delimited event stream that we
 * translate to Managed Agents events.
 *
 * Constraints:
 * - The prompt is passed as a positional argv (not stdin), so buildTurn
 *   returns an empty stdin body.
 * - System prompt is wrapped into the user prompt via the shared
 *   wrapPromptWithSystem helper.
 * - Custom tool re-entry is NOT supported in v1 — pi has no equivalent
 *   of claude's --input-format stream-json. buildTurn rejects
 *   toolResults.length > 0 with an invalid_request_error.
 */
import { ApiError } from "../../errors";
import type { Backend, BuildTurnInput, BuildTurnResult } from "../types";
import type { TranslatorOptions } from "../shared/translator-types";
import { wrapPromptWithSystem } from "../shared/wrap-prompt";
import { buildPiArgs } from "./args";
import { buildPiAuthEnv, validatePiRuntime } from "./auth";
import { createPiTranslator } from "./translator";
import { PI_WRAPPER_PATH } from "./wrapper-script";
import { preparePiOnSprite } from "./setup";

function buildTurn(input: BuildTurnInput): BuildTurnResult {
  const { agent, backendSessionId, promptText, toolResults } = input;
  if (toolResults.length > 0) {
    throw new ApiError(
      400,
      "invalid_request_error",
      "pi backend does not support user.custom_tool_result re-entry in v1",
    );
  }
  const wrappedPrompt = wrapPromptWithSystem(promptText, agent.system, agent.skills);
  const argv = buildPiArgs({ agent, backendSessionId, prompt: wrappedPrompt });
  const env = buildPiAuthEnv();
  // pi takes the prompt as a positional argv, not via stdin.
  return { argv, env, stdin: "" };
}

export const piBackend: Backend = {
  name: "pi" as Backend["name"],
  wrapperPath: PI_WRAPPER_PATH,
  buildTurn,
  createTranslator: (opts: TranslatorOptions) => createPiTranslator(opts),
  prepareOnSprite: (name, provider) => preparePiOnSprite(name, provider),

  validateRuntime: validatePiRuntime,
};

export {
  buildPiArgs,
  buildPiAuthEnv,
  createPiTranslator,
  preparePiOnSprite,
  PI_WRAPPER_PATH,
};
