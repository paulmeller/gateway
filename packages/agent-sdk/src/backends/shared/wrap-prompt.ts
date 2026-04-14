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
  skills?: Array<{ name: string; content: string }>,
): string {
  let systemBlock = systemPrompt || "";

  if (skills && skills.length > 0) {
    const skillsText = skills.map(s =>
      `<skill name="${s.name}">\n${s.content}\n</skill>`
    ).join("\n\n");
    systemBlock = systemBlock
      ? `${systemBlock}\n\n## Agent Skills\n\n${skillsText}`
      : `## Agent Skills\n\n${skillsText}`;
  }

  if (!systemBlock) return prompt;
  return `Instructions: ${systemBlock}\n\n---\n\n${prompt}`;
}
