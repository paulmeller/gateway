/**
 * Opencode backend: drives sst/opencode-ai's `opencode run` on sprites.dev
 * containers.
 *
 * Ported from
 * 
 * (the  opencode provider), adapted for our sprite-only
 * execution model. Opencompletions only ran opencode in its local backend;
 * this adapter is the first time opencode runs inside a sprites.dev sprite,
 * so the wrapper script + install flow are new (see wrapper-script.ts and
 * setup.ts).
 *
 * Custom tool re-entry (the stream-json user frame path claude uses) is NOT
 * supported by opencode — `opencode run` has no equivalent input format.
 * buildTurn rejects `toolResults.length > 0` with an invalid_request_error.
 */
import { ApiError } from "../../errors";
import type { Backend, BuildTurnInput, BuildTurnResult } from "../types";
import type { TranslatorOptions } from "../shared/translator-types";
import { wrapPromptWithSystem } from "../shared/wrap-prompt";
import { buildOpencodeArgs } from "./args";
import { buildOpencodeAuthEnv, validateOpencodeRuntime } from "./auth";
import { buildOpencodeMcpEnv } from "./mcp";
import { createOpencodeTranslator } from "./translator";
import { OPENCODE_WRAPPER_PATH, installOpencodeWrapper } from "./wrapper-script";
import { prepareOpencodeOnSprite } from "./setup";

function buildTurn(input: BuildTurnInput): BuildTurnResult {
  const { agent, backendSessionId, promptText, toolResults } = input;

  if (toolResults.length > 0) {
    throw new ApiError(
      400,
      "invalid_request_error",
      "opencode backend does not support user.custom_tool_result re-entry in v1",
    );
  }

  const argv = buildOpencodeArgs({ agent, backendSessionId });
  const wrappedPrompt = wrapPromptWithSystem(promptText, agent.system);
  const env = {
    ...buildOpencodeAuthEnv(),
    ...buildOpencodeMcpEnv(agent),
  };
  // stdin is the raw wrapped prompt — the driver prepends the env block.
  // The opencode wrapper script captures this via PROMPT=$(cat) and
  // re-passes it to `opencode` as a trailing positional argv.
  return { argv, env, stdin: wrappedPrompt };
}

export const opencodeBackend: Backend = {
  name: "opencode",
  wrapperPath: OPENCODE_WRAPPER_PATH,
  buildTurn,
  createTranslator: (opts: TranslatorOptions) => createOpencodeTranslator(opts),
  prepareOnSprite: (name, provider) => prepareOpencodeOnSprite(name, provider),

  validateRuntime: validateOpencodeRuntime,
};

// Re-exports for tests and other modules
export {
  buildOpencodeArgs,
  buildOpencodeAuthEnv,
  buildOpencodeMcpEnv,
  createOpencodeTranslator,
  installOpencodeWrapper,
  prepareOpencodeOnSprite,
  OPENCODE_WRAPPER_PATH,
};
