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
  // Ensure codex runs in a writable workspace. Without bwrap (--sandbox none),
  // codex inherits the container exec CWD which may be / or /root with no
  // project context, causing it to immediately exit with end_turn.
  'cd /home/user 2>/dev/null || cd /tmp',
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
