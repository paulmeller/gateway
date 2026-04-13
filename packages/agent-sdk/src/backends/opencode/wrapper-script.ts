/**
 * Sprite wrapper script for opencode.
 *
 * Opencode (unlike claude) does NOT accept the prompt on stdin — it takes
 * the prompt as a positional argv. But the prompt is too large/unsafe to
 * transport via sprites.dev's `?cmd=...` HTTP query params. So the wrapper:
 *
 *   1. Reads env vars from stdin until a blank line (same protocol as
 *      claude's wrapper — KEY=value per line, blank line terminator)
 *   2. Captures the remaining stdin into a `$PROMPT` shell variable
 *   3. Execs `opencode <argv> "$PROMPT"` — injecting the prompt as a
 *      trailing positional argv entry
 *
 * This keeps the prompt on the HTTP request body (not the URL) and still
 * lets opencode receive it in the argv shape it expects.
 *
 * NOTE: `buildOpencodeArgs` must never end argv with a flag that expects
 * its own value (e.g. a dangling `--model` without the model name) —
 * otherwise `"$PROMPT"` would bind to the wrong flag. All current
 * `buildOpencodeArgs` output is safe (flag + value pairs, no trailing
 * dangling flag).
 *
 * NOTE 2: `PROMPT=$(cat)` strips trailing newlines from the captured body.
 * For normal prompts this is a harmless quirk; very prompt-sensitive
 * consumers should be aware.
 */
import type { ContainerProvider } from "../../providers/types";

export const OPENCODE_WRAPPER_PATH = "/tmp/.opencode-wrapper";

const SPRITE_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  "set -e",
  'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done',
  "PROMPT=$(cat)",
  'exec opencode "$@" "$PROMPT"',
].join("\n");

export async function installOpencodeWrapper(spriteName: string, provider: ContainerProvider): Promise<void> {
  const escaped = SPRITE_WRAPPER_SCRIPT.replace(/'/g, "'\\''");
  await provider.exec(spriteName, [
    "bash",
    "-c",
    `printf '%s' '${escaped}' > ${OPENCODE_WRAPPER_PATH} && chmod +x ${OPENCODE_WRAPPER_PATH}`,
  ]);
}
