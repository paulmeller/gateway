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

const SANDBOX_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  "set -e",
  'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done',
  "PROMPT=$(cat)",
  // Sprites keep-alive: prevent VM suspension during long agent turns.
  'SPRITE_SOCK="/.sprite/api.sock"',
  'HEARTBEAT_PID=""',
  'if [ -S "$SPRITE_SOCK" ]; then',
  '  curl -sf --unix-socket "$SPRITE_SOCK" -H "Host: sprite" \\',
  '    -X POST http://sprite/v1/tasks \\',
  '    -H "Content-Type: application/json" \\',
  '    -d \'{"name":"agent-turn","expire":"5m"}\' >/dev/null 2>&1',
  '  (while sleep 60; do',
  '    curl -sf --unix-socket "$SPRITE_SOCK" -H "Host: sprite" \\',
  '      -X PUT http://sprite/v1/tasks/agent-turn \\',
  '      -H "Content-Type: application/json" \\',
  '      -d \'{"expire":"5m"}\' >/dev/null 2>&1',
  '  done) &',
  '  HEARTBEAT_PID=$!',
  '  trap \'curl -sf --unix-socket "$SPRITE_SOCK" -H "Host: sprite" -X DELETE http://sprite/v1/tasks/agent-turn >/dev/null 2>&1; [ -n "$HEARTBEAT_PID" ] && kill $HEARTBEAT_PID 2>/dev/null\' EXIT',
  'fi',
  'opencode "$@" "$PROMPT"',
].join("\n");

export async function installOpencodeWrapper(sandboxName: string, provider: ContainerProvider): Promise<void> {
  const escaped = SANDBOX_WRAPPER_SCRIPT.replace(/'/g, "'\\''");
  await provider.exec(sandboxName, [
    "bash",
    "-c",
    `printf '%s' '${escaped}' > ${OPENCODE_WRAPPER_PATH} && chmod +x ${OPENCODE_WRAPPER_PATH}`,
  ]);
}
