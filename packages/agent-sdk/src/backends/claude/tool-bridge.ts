/**
 * Custom tool bridge: generates a synthetic MCP stdio server that exposes
 * Managed Agents custom tools to claude inside the container.
 *
 * Architecture:
 *   - A pure-bash script that implements the MCP stdio protocol (JSON-RPC on
 *     stdin/stdout) — no Node.js dependency, instant startup (~10ms vs ~1.2s
 *     on Firecracker VMs)
 *   - Reads tool definitions from /tmp/tool-bridge/tools.json
 *   - On tool call: checks for pre-existing response.json (replay after
 *     --resume) and returns immediately. Otherwise writes request.json +
 *     creates pending sentinel, then polls for response.json (200ms interval,
 *     5-min timeout) and returns the result.
 *   - Handles both raw JSON lines (Claude Code v2.1.83+) and Content-Length
 *     framed JSON-RPC input; always responds with raw JSON lines.
 *
 * The driver polls for /tmp/tool-bridge/pending every 1s during the stream
 * loop. When found, it reads request.json, emits agent.custom_tool_use, and
 * waits for user.custom_tool_result to write response.json and remove the
 * pending sentinel.
 */

import type { CustomTool } from "../../types";

export const TOOL_BRIDGE_DIR = "/tmp/tool-bridge";
export const TOOL_BRIDGE_SCRIPT_PATH = `${TOOL_BRIDGE_DIR}/bridge.sh`;
export const TOOL_BRIDGE_TOOLS_PATH = `${TOOL_BRIDGE_DIR}/tools.json`;
export const TOOL_BRIDGE_REQUEST_PATH = `${TOOL_BRIDGE_DIR}/request.json`;
export const TOOL_BRIDGE_RESPONSE_PATH = `${TOOL_BRIDGE_DIR}/response.json`;
export const TOOL_BRIDGE_PENDING_PATH = `${TOOL_BRIDGE_DIR}/pending`;

/**
 * Generate the MCP stdio server script as a string.
 * This script is written to the container and run by claude's --mcp-config.
 */
/**
 * Generate a pure-bash MCP stdio server. No Node.js — instant startup
 * (~10ms vs ~1.2s for Node on Firecracker VMs).
 *
 * Handles both raw JSON lines (Claude Code v2.1.83+) and Content-Length
 * framed JSON-RPC. Responds with raw JSON lines (no Content-Length
 * framing) — required by newer Claude Code versions.
 */
export function generateBridgeScript(): string {
  return `#!/bin/bash
# Auto-generated MCP stdio server for custom tool bridge.
# Pure bash — no Node.js dependency. Instant startup on Firecracker VMs.

TOOLS_PATH="${TOOL_BRIDGE_TOOLS_PATH}"
REQUEST_PATH="${TOOL_BRIDGE_REQUEST_PATH}"
RESPONSE_PATH="${TOOL_BRIDGE_RESPONSE_PATH}"
PENDING_PATH="${TOOL_BRIDGE_PENDING_PATH}"

send_response() {
  printf '%s\\n' "$1"
}

TOOLS_LIST_JSON=""
if [ -f "$TOOLS_PATH" ]; then
  TOOLS_LIST_JSON=$(sed 's/input_schema/inputSchema/g' "$TOOLS_PATH")
fi

handle_request() {
  local body="$1"
  local method id
  method=$(echo "$body" | grep -o '"method":"[^"]*"' | head -1 | cut -d'"' -f4)
  id=$(echo "$body" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)

  case "$method" in
    initialize)
      send_response '{"jsonrpc":"2.0","id":'"$id"',"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"tool-bridge","version":"1.0.0"}}}'
      ;;
    notifications/initialized) ;;
    tools/list)
      send_response '{"jsonrpc":"2.0","id":'"$id"',"result":{"tools":'"$TOOLS_LIST_JSON"'}}'
      ;;
    tools/call)
      local tool_name tool_args
      tool_name=$(echo "$body" | grep -o '"name":"[^"]*"' | tail -1 | cut -d'"' -f4)
      tool_args=$(echo "$body" | grep -o '"arguments":{[^}]*}' | head -1 | sed 's/^"arguments"://')
      [ -z "$tool_args" ] && tool_args="{}"

      # Replay case: response.json already exists (--resume re-entry)
      if [ -f "$RESPONSE_PATH" ]; then
        local rdata
        rdata=$(cat "$RESPONSE_PATH" | tr -d '\\n' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
        rm -f "$RESPONSE_PATH"
        send_response '{"jsonrpc":"2.0","id":'"$id"',"result":{"content":[{"type":"text","text":"'"$rdata"'"}],"isError":false}}'
        return
      fi

      # Write request and create pending sentinel
      printf '{"tool_use_id":%s,"name":"%s","input":%s}' "$id" "$tool_name" "$tool_args" > "$REQUEST_PATH"
      touch "$PENDING_PATH"

      # Poll for response.json (200ms interval, 5min timeout)
      local elapsed=0
      while [ $elapsed -lt 1500 ]; do
        if [ -f "$RESPONSE_PATH" ]; then
          local rdata
          rdata=$(cat "$RESPONSE_PATH" | tr -d '\\n' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
          rm -f "$RESPONSE_PATH" "$PENDING_PATH"
          send_response '{"jsonrpc":"2.0","id":'"$id"',"result":{"content":[{"type":"text","text":"'"$rdata"'"}],"isError":false}}'
          return
        fi
        sleep 0.2
        elapsed=$((elapsed + 1))
      done
      # Timeout
      rm -f "$PENDING_PATH"
      send_response '{"jsonrpc":"2.0","id":'"$id"',"error":{"code":-32603,"message":"Timeout waiting for tool response"}}'
      ;;
    *)
      [ -n "$id" ] && send_response '{"jsonrpc":"2.0","id":'"$id"',"error":{"code":-32601,"message":"Method not found"}}'
      ;;
  esac
}

# Main loop: handle both raw JSON lines and Content-Length framed messages
while IFS= read -r line; do
  line=\${line%$'\\r'}
  [ -z "$line" ] && continue
  case "$line" in
    Content-Length:*)
      while IFS= read -r hdr; do hdr=\${hdr%$'\\r'}; [ -z "$hdr" ] && break; done
      body=$(head -c "\${line#Content-Length: }")
      handle_request "$body" ;;
    "{"*) handle_request "$line" ;;
  esac
done
`;
}

/**
 * Build the --mcp-config JSON snippet that adds the tool bridge server
 * alongside any existing MCP servers.
 */
export function buildBridgeMcpConfig(
  existingServers: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...existingServers,
    "tool-bridge": {
      command: "bash",
      args: [TOOL_BRIDGE_SCRIPT_PATH],
    },
  };
}

/**
 * Convert CustomTool definitions to the tool bridge's tools.json format.
 */
export function toolsToJson(tools: CustomTool[]): string {
  return JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    })),
  );
}
