/**
 * Sprite wrapper script for codex.
 *
 * Identical structure to the claude wrapper because codex has
 * promptViaStdin: true — the wrapper reads env vars from stdin until a
 * blank line, then execs codex with the remaining stdin piped through as
 * the prompt. The trailing `-` in argv tells codex to read from stdin.
 */
import type { ContainerProvider } from "../../providers/types";

export const CODEX_WRAPPER_PATH = "/tmp/.codex-wrapper";

const SPRITE_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done',
  'exec codex "$@"',
].join("\n");

export async function installCodexWrapper(spriteName: string, provider: ContainerProvider): Promise<void> {
  const escaped = SPRITE_WRAPPER_SCRIPT.replace(/'/g, "'\\''");
  await provider.exec(spriteName, [
    "bash",
    "-c",
    `printf '%s' '${escaped}' > ${CODEX_WRAPPER_PATH} && chmod +x ${CODEX_WRAPPER_PATH}`,
  ]);
}
