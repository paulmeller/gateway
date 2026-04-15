/**
 * Build the `pi` argv for one turn.
 *
 * pi.dev CLI constraints:
 * - Prompt is passed as a positional argument (`pi "<prompt>"`)
 * - `--mode json` streams every event as newline-delimited JSON, which is
 *   the format our translator consumes
 * - `-p` / `--print` makes the run non-interactive and exit on completion
 * - `--session <id>` resumes a prior session by uuid (or partial uuid) on
 *   turns >= 2; pi auto-saves sessions to ~/.pi/agent/sessions
 * - `--model <provider/id[:level]>` selects the LLM
 * - `--no-extensions` skips local extension discovery so behavior is
 *   deterministic across sprites
 * - System prompt is wrapped into the user prompt text via the shared
 *   wrapPromptWithSystem helper (pi has --system-prompt but we keep the
 *   same approach as the other prompt-wrapping backends to share the
 *   skills-injection codepath).
 */
import type { Agent } from "../../types";

export interface BuildPiArgsInput {
  agent: Agent;
  /** Prior turn's pi session id, if any, for --session */
  backendSessionId: string | null;
  /** The wrapped prompt text to pass as the positional argument */
  prompt: string;
}

export function buildPiArgs(input: BuildPiArgsInput): string[] {
  const args: string[] = [
    "-p",
    "--mode", "json",
    "--no-extensions",
  ];

  if (input.backendSessionId) {
    args.push("--session", input.backendSessionId);
  }

  if (input.agent.model) {
    args.push("--model", input.agent.model);
  }

  // Positional prompt argument — pi treats the first non-flag arg as the prompt.
  args.push(input.prompt);

  return args;
}
