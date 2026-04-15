/**
 * Sprite wrapper script for factory (droid).
 *
 * Factory's `droid exec` takes the prompt as a positional argument (like
 * opencode), NOT from stdin. The wrapper:
 *
 *   1. Reads env vars from stdin until a blank line
 *   2. Captures the remaining stdin into $PROMPT
 *   3. Execs `droid exec "$@" "$PROMPT"` — the prompt becomes the last
 *      positional arg after any flags from argv
 *
 * This mirrors the opencode wrapper pattern exactly.
 */
import type { ContainerProvider } from "../../providers/types";

export const FACTORY_WRAPPER_PATH = "/tmp/.factory-wrapper";

const SPRITE_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  "set -e",
  'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done',
  "PROMPT=$(cat)",
  'exec droid "$@" "$PROMPT"',
].join("\n");

export async function installFactoryWrapper(spriteName: string, provider: ContainerProvider): Promise<void> {
  const escaped = SPRITE_WRAPPER_SCRIPT.replace(/'/g, "'\\''");
  await provider.exec(spriteName, [
    "bash",
    "-c",
    `printf '%s' '${escaped}' > ${FACTORY_WRAPPER_PATH} && chmod +x ${FACTORY_WRAPPER_PATH}`,
  ]);
}
