/**
 * Build the `gemini --prompt` argv for one turn.
 *
 * Gemini CLI constraints:
 * - `--prompt <text>` for non-interactive mode (text passed as arg value)
 * - `--output-format stream-json` for NDJSON streaming
 * - `--yolo` to bypass permission prompts in headless mode
 * - `--max-turns <N>` to cap reasoning turns
 * - `--resume <session_id>` on turn >= 2
 * - `--model <model>` if specified on the agent
 * - No --system-prompt flag — system prompt is wrapped into the user
 *   prompt text via the shared wrapPromptWithSystem utility
 */
import { getConfig } from "../../config";
import type { Agent } from "../../types";

export interface BuildGeminiArgsInput {
  agent: Agent;
  /** Prior turn's gemini session ID, if any, for --resume */
  backendSessionId: string | null;
  maxTurns?: number;
  /** The prompt text to pass via --prompt */
  prompt?: string;
}

export function buildGeminiArgs(input: BuildGeminiArgsInput): string[] {
  const args: string[] = [
    "--prompt", input.prompt || "",
    "--output-format", "stream-json",
    "--yolo",
  ];

  if (input.backendSessionId) {
    args.push("--resume", input.backendSessionId);
  }

  if (input.agent.model) {
    args.push("--model", input.agent.model);
  }

  return args;
}
