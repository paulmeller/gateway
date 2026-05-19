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

const SANDBOX_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done',
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
  'pi "$@"',
].join("\n");

export async function installPiWrapper(sandboxName: string, provider: ContainerProvider): Promise<void> {
  const escaped = SANDBOX_WRAPPER_SCRIPT.replace(/'/g, "'\\''");
  await provider.exec(sandboxName, [
    "bash",
    "-c",
    `printf '%s' '${escaped}' > ${PI_WRAPPER_PATH} && chmod +x ${PI_WRAPPER_PATH}`,
  ]);
}
