/**
 * Build the `droid exec` argv for one turn.
 *
 * Factory CLI constraints:
 * - Uses `exec` subcommand (not `-p`)
 * - `--output-format stream-json` for NDJSON streaming
 * - `--auto high` for headless non-interactive execution
 * - `--session-id <session_id>` on turn >= 2
 * - `--model <model>` if specified on the agent
 * - No --system-prompt flag — system prompt is wrapped into the user
 *   prompt text via the shared wrapPromptWithSystem utility
 * - The prompt is positional (last arg), NOT a flag. The wrapper script
 *   captures it from stdin and passes it as `"$PROMPT"` at the end.
 */
import type { Agent } from "../../types";

export interface BuildFactoryArgsInput {
  agent: Agent;
  /** Prior turn's factory session ID, if any, for --session-id resume */
  backendSessionId: string | null;
}

export function buildFactoryArgs(input: BuildFactoryArgsInput): string[] {
  const args: string[] = [
    "exec",
    "--output-format",
    "stream-json",
    "--auto",
    "high",
  ];

  if (input.backendSessionId) {
    args.push("--session-id", input.backendSessionId);
  }

  if (input.agent.model) {
    args.push("--model", input.agent.model);
  }

  // NOTE: No trailing `-` or positional prompt here. The factory wrapper
  // script captures the prompt from stdin via PROMPT=$(cat) and appends it
  // as the last positional arg to `droid exec "$@" "$PROMPT"`.

  return args;
}
