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

const SANDBOX_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  // Read env vars from stdin until blank line
  'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done',
  // Save remaining stdin (the prompt) to a temp file — avoids partial-stdin
  // issues when exec replaces the process, matching the claude wrapper pattern.
  'PROMPT_FILE=$(mktemp)',
  'cat > "$PROMPT_FILE"',
  // Sprites keep-alive: prevent VM suspension during long agent turns.
  // Only activates if the sprites management socket exists (sprites containers only).
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
  // Set CWD to the first cloned repo if available, otherwise the user's home.
  // Without bwrap (--sandbox none), codex inherits the container exec CWD
  // which may be / or /root with no project context.
  'REPO_DIR=$(find /mnt/session/resources -maxdepth 1 -name "repo_*" -type d 2>/dev/null | head -1)',
  'if [ -n "$REPO_DIR" ]; then cd "$REPO_DIR"',
  'elif [ -d /home/sprite ]; then cd /home/sprite',
  'elif [ -d /home/user ]; then cd /home/user',
  'else cd /tmp; fi',
  'codex "$@" < "$PROMPT_FILE"',
  'EXIT_CODE=$?',
  'rm -f "$PROMPT_FILE"',
  'exit $EXIT_CODE',
].join("\n");

export async function installCodexWrapper(sandboxName: string, provider: ContainerProvider): Promise<void> {
  const escaped = SANDBOX_WRAPPER_SCRIPT.replace(/'/g, "'\\''");
  await provider.exec(sandboxName, [
    "bash",
    "-c",
    `printf '%s' '${escaped}' > ${CODEX_WRAPPER_PATH} && chmod +x ${CODEX_WRAPPER_PATH}`,
  ]);
}
