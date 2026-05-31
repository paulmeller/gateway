/**
 * Sprite wrapper script for claude.
 *
 * Reads env vars from stdin (one per line) until a blank line, then execs
 * the real `claude` binary with the remaining stdin piped into claude as
 * the prompt. Credentials never hit URLs or disk.
 *
 * Compatible with Alpine Linux (ash/sh) — no bash required.
 */
import type { ContainerProvider } from "../../providers/types";

// Use /tmp/ for wrapper scripts — it exists on all container runtimes
export const CLAUDE_WRAPPER_PATH = "/tmp/.claude-wrapper";

const SANDBOX_WRAPPER_SCRIPT = `#!/bin/sh
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# V8 bytecode cache: Node.js caches compiled JS to disk.
# First run builds cache (~55s). Subsequent runs skip V8 compilation (~8s startup).
export NODE_COMPILE_CACHE=/tmp/v8-cache
mkdir -p /tmp/v8-cache
# Install claude CLI if not present
if ! command -v claude >/dev/null 2>&1; then npm install -g @anthropic-ai/claude-code; fi
claude --version >&2 2>/dev/null || true
# Sprites keep-alive: prevent VM suspension during long agent turns.
# Only activates if the sprites management socket exists (sprites containers only).
SPRITE_SOCK="/.sprite/api.sock"
HEARTBEAT_PID=""
if [ -S "$SPRITE_SOCK" ]; then
  # Create task with 5-minute expiry
  curl -sf --unix-socket "$SPRITE_SOCK" -H "Host: sprite" \
    -X POST http://sprite/v1/tasks \
    -H "Content-Type: application/json" \
    -d '{"name":"agent-turn","expire":"5m"}' >/dev/null 2>&1
  # Background heartbeat: refresh every 60s
  (while sleep 60; do
    curl -sf --unix-socket "$SPRITE_SOCK" -H "Host: sprite" \
      -X PUT http://sprite/v1/tasks/agent-turn \
      -H "Content-Type: application/json" \
      -d '{"expire":"5m"}' >/dev/null 2>&1
  done) &
  HEARTBEAT_PID=$!
  # Cleanup on exit
  trap 'curl -sf --unix-socket "$SPRITE_SOCK" -H "Host: sprite" -X DELETE http://sprite/v1/tasks/agent-turn >/dev/null 2>&1; [ -n "$HEARTBEAT_PID" ] && kill $HEARTBEAT_PID 2>/dev/null' EXIT
fi
# Read env vars from stdin until blank line, save remaining stdin to temp file.
# Use a dotted prefix so container-file-sync skips these wrapper-internal
# files (the ENV_FILE contains plaintext credentials and must never reach
# the gateway's file store).
PROMPT_FILE=$(mktemp /tmp/.claude-cw.XXXXXXXXXX)
while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done
cat > "$PROMPT_FILE"
# Run as non-root if possible (claude requires non-root for bypassPermissions)
if [ "$(id -u)" = "0" ]; then
  if ! id agent >/dev/null 2>&1; then
    useradd -m -s /bin/sh agent 2>/dev/null || adduser -D -s /bin/sh agent 2>/dev/null
  fi
  chown -R agent /tmp/ 2>/dev/null
  chown -R agent /home/agent 2>/dev/null
  # Export env vars to a file for the agent user. Dotted prefix as above.
  ENV_FILE=$(mktemp /tmp/.claude-cw.XXXXXXXXXX)
  env | grep -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|NODE_COMPILE_CACHE|PATH)=' > "$ENV_FILE"
  # Build a runner script with each argv entry properly single-quoted.
  # Passing args via \\$* (or whitespace-joined re-expansion) inside the
  # inner \`su -c "..."\` word-splits multi-word entries like
  # --system-prompt "Long text..." — claude then mis-parses the system
  # prompt and the runover words become the positional prompt, dropping
  # the real user input on the floor.
  #
  # Strategy: write a per-invocation runner script that contains the
  # properly-quoted claude invocation, then \`su -c "exec $RUN_FILE"\`.
  # The single string passed to \`su -c\` is just a /tmp path with no
  # spaces, so its own re-tokenisation can't break anything.
  RUN_FILE=$(mktemp /tmp/.claude-cw.XXXXXXXXXX)
  {
    echo '#!/bin/sh'
    echo ". $ENV_FILE"
    printf 'HOME=/home/agent exec claude'
    for arg in "$@"; do
      # POSIX sh single-quote escape: every ' becomes '\\''
      # (close the open '-quoted string, escaped \\', reopen '-quoted).
      # We use awk with the \\x27 escape so the awk program text never
      # contains an actual ' that would collide with shell quoting.
      esc=$(printf '%s' "$arg" | awk 'BEGIN{ORS=""} {gsub(/\\x27/, "\\x27\\\\\\x27\\x27"); print}')
      printf " '%s'" "$esc"
    done
    printf ' < %s\\n' "$PROMPT_FILE"
  } > "$RUN_FILE"
  chmod +x "$RUN_FILE"
  chown agent "$ENV_FILE" "$PROMPT_FILE" "$RUN_FILE"
  exec su -s /bin/sh agent -c "exec $RUN_FILE; rm -f $ENV_FILE $PROMPT_FILE $RUN_FILE"
fi
# Run claude and clean up temp file (no exec — let cleanup run)
claude "$@" < "$PROMPT_FILE"
EXIT_CODE=$?
rm -f "$PROMPT_FILE"
exit $EXIT_CODE
`;

export async function installClaudeWrapper(sandboxName: string, provider: ContainerProvider): Promise<void> {
  // Write wrapper via stdin to avoid quoting issues through SSH
  console.log(`[wrapper] writing ${CLAUDE_WRAPPER_PATH} to ${sandboxName} (${SANDBOX_WRAPPER_SCRIPT.length} bytes)`);
  const result = await provider.exec(sandboxName, [
    "sh",
    "-c",
    `cat > ${CLAUDE_WRAPPER_PATH} && chmod +x ${CLAUDE_WRAPPER_PATH} && echo OK`,
  ], { stdin: SANDBOX_WRAPPER_SCRIPT });
  console.log(`[wrapper] result: exit=${result.exit_code} stdout="${result.stdout.trim()}" stderr="${result.stderr.trim()}"`);
}
