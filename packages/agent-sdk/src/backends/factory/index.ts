/**
 * Factory backend: drives Factory's `droid exec` on sprites.dev containers.
 *
 * Factory CLI uses `exec` subcommand with the prompt as a positional arg
 * (like opencode). The wrapper script captures stdin and re-passes it as
 * the trailing positional argv.
 *
 * Custom tool re-entry is NOT supported by factory — droid exec has no
 * equivalent of claude's --input-format stream-json. buildTurn rejects
 * toolResults.length > 0 with an invalid_request_error.
 */
import { ApiError } from "../../errors";
import type { Backend, BuildTurnInput, BuildTurnResult } from "../types";
import type { TranslatorOptions } from "../shared/translator-types";
import { wrapPromptWithSystem } from "../shared/wrap-prompt";
import { buildFactoryArgs } from "./args";
import { buildFactoryAuthEnv, validateFactoryRuntime } from "./auth";
import { createFactoryTranslator } from "./translator";
import { FACTORY_WRAPPER_PATH } from "./wrapper-script";
import { prepareFactoryOnSprite } from "./setup";

function buildTurn(input: BuildTurnInput): BuildTurnResult {
  const { agent, backendSessionId, promptText, toolResults } = input;
  if (toolResults.length > 0) {
    throw new ApiError(
      400,
      "invalid_request_error",
      "factory backend does not support user.custom_tool_result re-entry in v1",
    );
  }
  const argv = buildFactoryArgs({ agent, backendSessionId });
  const env = buildFactoryAuthEnv();
  const wrappedPrompt = wrapPromptWithSystem(promptText, agent.system, agent.skills);
  // stdin is the raw wrapped prompt — the driver prepends the env block.
  // The factory wrapper script captures this via PROMPT=$(cat) and
  // re-passes it to `droid exec` as a trailing positional argv.
  return { argv, env, stdin: wrappedPrompt };
}

export const factoryBackend: Backend = {
  name: "factory" as Backend["name"],
  wrapperPath: FACTORY_WRAPPER_PATH,
  buildTurn,
  createTranslator: (opts: TranslatorOptions) => createFactoryTranslator(opts),
  prepareOnSprite: (name, provider) => prepareFactoryOnSprite(name, provider),

  validateRuntime: validateFactoryRuntime,
};

export {
  buildFactoryArgs,
  buildFactoryAuthEnv,
  createFactoryTranslator,
  prepareFactoryOnSprite,
  FACTORY_WRAPPER_PATH,
};
