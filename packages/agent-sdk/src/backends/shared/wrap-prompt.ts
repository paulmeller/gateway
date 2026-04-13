/**
 * Shared prompt wrapper for backends that lack a `--system-prompt` CLI flag
 * (opencode, codex). If a system prompt is set on the agent, prepend it to
 * the user prompt with a separator. If no system prompt, return the prompt
 * unchanged.
 *
 * Pattern from
 * 
 * (opencode) and 253-256 (codex) — both use the identical wrapping format.
 */
export function wrapPromptWithSystem(
  prompt: string,
  systemPrompt: string | null | undefined,
): string {
  if (!systemPrompt) return prompt;
  return `Instructions: ${systemPrompt}\n\n---\n\n${prompt}`;
}
