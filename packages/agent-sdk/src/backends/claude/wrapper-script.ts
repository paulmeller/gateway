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

const SPRITE_WRAPPER_SCRIPT = `#!/bin/sh
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# V8 bytecode cache: Node.js caches compiled JS to disk.
# First run builds cache (~55s). Subsequent runs skip V8 compilation (~8s startup).
export NODE_COMPILE_CACHE=/tmp/v8-cache
mkdir -p /tmp/v8-cache
# Install claude CLI if not present
if ! command -v claude >/dev/null 2>&1; then npm install -g @anthropic-ai/claude-code 2>/dev/null; fi
# Read env vars from stdin until blank line, save remaining stdin to temp file
PROMPT_FILE=$(mktemp)
while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done
cat > "$PROMPT_FILE"
# Run as non-root if possible (claude requires non-root for bypassPermissions)
if [ "$(id -u)" = "0" ]; then
  if ! id agent >/dev/null 2>&1; then
    useradd -m -s /bin/sh agent 2>/dev/null || adduser -D -s /bin/sh agent 2>/dev/null
  fi
  chown -R agent /tmp/ 2>/dev/null
  chown -R agent /home/agent 2>/dev/null
  # Export env vars to a file for the agent user
  ENV_FILE=$(mktemp)
  env | grep -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|NODE_COMPILE_CACHE|PATH)=' > "$ENV_FILE"
  chown agent "$ENV_FILE" "$PROMPT_FILE"
  exec su -s /bin/sh agent -c ". $ENV_FILE && HOME=/home/agent claude $* < $PROMPT_FILE; rm -f $ENV_FILE $PROMPT_FILE"
fi
exec claude "$@" < "$PROMPT_FILE"
rm -f "$PROMPT_FILE"
`;

export async function installClaudeWrapper(spriteName: string, provider: ContainerProvider): Promise<void> {
  // Write wrapper via stdin to avoid quoting issues through SSH
  console.log(`[wrapper] writing ${CLAUDE_WRAPPER_PATH} to ${spriteName} (${SPRITE_WRAPPER_SCRIPT.length} bytes)`);
  const result = await provider.exec(spriteName, [
    "sh",
    "-c",
    `cat > ${CLAUDE_WRAPPER_PATH} && chmod +x ${CLAUDE_WRAPPER_PATH} && echo OK`,
  ], { stdin: SPRITE_WRAPPER_SCRIPT });
  console.log(`[wrapper] result: exit=${result.exit_code} stdout="${result.stdout.trim()}" stderr="${result.stderr.trim()}"`);
}
