/**
 * Sprite wrapper script for pi (pi.dev coding agent).
 *
 * Same structure as the gemini/codex wrappers: pi accepts the prompt as a
 * positional arg, so the wrapper reads env vars from stdin until a blank
 * line, then execs pi with the remaining argv. Any prompt body delivered
 * on stdin is piped through to pi, which accepts piped stdin as additional
 * prompt context (e.g. `cat file | pi -p "summarize"`).
 */
import type { ContainerProvider } from "../../providers/types";

export const PI_WRAPPER_PATH = "/tmp/.pi-wrapper";

const SPRITE_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done',
  'exec pi "$@"',
].join("\n");

export async function installPiWrapper(spriteName: string, provider: ContainerProvider): Promise<void> {
  const escaped = SPRITE_WRAPPER_SCRIPT.replace(/'/g, "'\\''");
  await provider.exec(spriteName, [
    "bash",
    "-c",
    `printf '%s' '${escaped}' > ${PI_WRAPPER_PATH} && chmod +x ${PI_WRAPPER_PATH}`,
  ]);
}
