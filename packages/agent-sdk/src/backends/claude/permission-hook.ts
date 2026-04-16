/**
 * Permission hook bridge: generates a Node.js hook script that bridges
 * Claude Code's PermissionRequest hook to the Managed Agents API's
 * `user.tool_confirmation` flow.
 *
 * Architecture:
 *   - A Node.js script installed at /tmp/permission-bridge/hook.mjs
 *   - Claude Code fires PermissionRequest hooks when running in
 *     `--permission-mode default` and a tool needs approval
 *   - The hook receives the permission request JSON on stdin
 *   - It writes /tmp/permission-bridge/request.json with tool details
 *   - Creates /tmp/permission-bridge/pending sentinel
 *   - Blocks polling for /tmp/permission-bridge/response.json via fs.watchFile
 *   - On response: outputs the hook result JSON to stdout and cleans up
 *
 * The driver detects the pending sentinel via a background poller during
 * the stream loop. When found, it emits `agent.tool_confirmation_request`
 * on the event bus and waits for the client to POST `user.tool_confirmation`.
 * The events route writes response.json into the container, unblocking the hook.
 */

export const PERMISSION_BRIDGE_DIR = "/tmp/permission-bridge";
export const PERMISSION_HOOK_SCRIPT_PATH = `${PERMISSION_BRIDGE_DIR}/hook.mjs`;
export const PERMISSION_BRIDGE_REQUEST_PATH = `${PERMISSION_BRIDGE_DIR}/request.json`;
export const PERMISSION_BRIDGE_RESPONSE_PATH = `${PERMISSION_BRIDGE_DIR}/response.json`;
export const PERMISSION_BRIDGE_PENDING_PATH = `${PERMISSION_BRIDGE_DIR}/pending`;

/**
 * Generate the PermissionRequest hook script as a string.
 * This script is written to the container and referenced from
 * $HOME/.claude/settings.json hooks config.
 */
export function generatePermissionHookScript(): string {
  return `#!/usr/bin/env node
// Auto-generated PermissionRequest hook for tool confirmation bridge.
// Reads hook JSON from stdin, writes request.json + pending sentinel,
// polls for response.json, then outputs the hook response to stdout.
import { readFileSync, writeFileSync, unlinkSync, existsSync, watchFile, unwatchFile } from 'node:fs';

const REQUEST_PATH = ${JSON.stringify(PERMISSION_BRIDGE_REQUEST_PATH)};
const RESPONSE_PATH = ${JSON.stringify(PERMISSION_BRIDGE_RESPONSE_PATH)};
const PENDING_PATH = ${JSON.stringify(PERMISSION_BRIDGE_PENDING_PATH)};
const TIMEOUT_MS = 120000; // 2 minutes

// Read hook input from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let hookInput;
  try {
    hookInput = JSON.parse(input);
  } catch (e) {
    // If we can't parse the input, allow by default to avoid blocking
    console.error('[permission-hook] failed to parse stdin:', e.message);
    outputResult({ behavior: 'allow' });
    return;
  }

  // Extract tool details from the PermissionRequest hook payload.
  // Claude Code sends: { tool_name, tool_input, tool_use_id, ... }
  const toolName = hookInput.tool_name || hookInput.toolName || 'unknown';
  const toolInput = hookInput.tool_input || hookInput.toolInput || {};
  const toolUseId = hookInput.tool_use_id || hookInput.toolUseId || '';

  // Write request.json with tool details
  writeFileSync(REQUEST_PATH, JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  }));

  // Create pending sentinel
  writeFileSync(PENDING_PATH, '');

  // Poll for response.json
  const startTime = Date.now();
  let resolved = false;

  const checkResponse = () => {
    if (resolved) return;
    if (!existsSync(RESPONSE_PATH)) return;
    resolved = true;
    try { unwatchFile(RESPONSE_PATH, pollFn); } catch {}
    if (timeoutTimer) clearTimeout(timeoutTimer);

    try {
      const resp = JSON.parse(readFileSync(RESPONSE_PATH, 'utf8'));
      try { unlinkSync(RESPONSE_PATH); } catch {}
      try { unlinkSync(PENDING_PATH); } catch {}

      if (resp.result === 'allow') {
        outputResult({ behavior: 'allow' });
      } else {
        outputResult({ behavior: 'deny', message: resp.deny_message || 'User denied tool use' });
      }
    } catch (e) {
      console.error('[permission-hook] failed to read response:', e.message);
      // On error, deny to be safe
      try { unlinkSync(PENDING_PATH); } catch {}
      outputResult({ behavior: 'deny', message: 'Permission hook error: ' + e.message });
    }
  };

  const pollFn = () => checkResponse();

  // Check immediately in case response was pre-written
  checkResponse();
  if (resolved) return;

  // Use fs.watchFile for reliable polling
  watchFile(RESPONSE_PATH, { interval: 200 }, pollFn);

  // Timeout: deny after TIMEOUT_MS
  const timeoutTimer = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    try { unwatchFile(RESPONSE_PATH, pollFn); } catch {}
    try { unlinkSync(PENDING_PATH); } catch {}
    outputResult({ behavior: 'deny', message: 'Permission request timed out after ' + (TIMEOUT_MS / 1000) + 's' });
  }, TIMEOUT_MS);
});

function outputResult(decision) {
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: decision,
    },
  });
  process.stdout.write(output);
  process.exit(0);
}
`;
}

/**
 * Build the settings.json hooks configuration for the permission hook.
 * Returns the JSON object to merge into $HOME/.claude/settings.json.
 */
export function buildPermissionHooksConfig(): Record<string, unknown> {
  return {
    hooks: {
      PermissionRequest: [
        {
          type: "command",
          command: `node ${PERMISSION_HOOK_SCRIPT_PATH}`,
        },
      ],
    },
  };
}
