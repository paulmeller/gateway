/**
 * Custom tool bridge: generates a synthetic MCP stdio server that exposes
 * Managed Agents custom tools to claude inside the container.
 *
 * Architecture:
 *   - A Node.js script that implements the MCP stdio protocol (JSON-RPC on
 *     stdin/stdout)
 *   - Reads tool definitions from /tmp/tool-bridge/tools.json
 *   - On tool call: checks for pre-existing response.json (replay after
 *     --resume) and returns immediately. Otherwise writes request.json +
 *     creates pending sentinel, then watches for response.json via
 *     fs.watchFile and returns the result.
 *
 * The driver detects custom_tool_use via the translator's sawCustomToolUse()
 * flag and stop_reason:"custom_tool_call". On user.custom_tool_result
 * re-entry, the driver writes response.json and removes the pending sentinel
 * before calling --resume.
 */

import type { CustomTool } from "../../types";

export const TOOL_BRIDGE_DIR = "/tmp/tool-bridge";
export const TOOL_BRIDGE_SCRIPT_PATH = `${TOOL_BRIDGE_DIR}/bridge.mjs`;
export const TOOL_BRIDGE_TOOLS_PATH = `${TOOL_BRIDGE_DIR}/tools.json`;
export const TOOL_BRIDGE_REQUEST_PATH = `${TOOL_BRIDGE_DIR}/request.json`;
export const TOOL_BRIDGE_RESPONSE_PATH = `${TOOL_BRIDGE_DIR}/response.json`;
export const TOOL_BRIDGE_PENDING_PATH = `${TOOL_BRIDGE_DIR}/pending`;

/**
 * Generate the MCP stdio server script as a string.
 * This script is written to the container and run by claude's --mcp-config.
 */
export function generateBridgeScript(): string {
  return `#!/usr/bin/env node
// Auto-generated MCP stdio server for custom tool bridge.
// Reads tool definitions from ${TOOL_BRIDGE_TOOLS_PATH}
import { readFileSync, writeFileSync, unlinkSync, existsSync, watch, watchFile, unwatchFile } from 'node:fs';
import { createInterface } from 'node:readline';

const TOOLS_PATH = ${JSON.stringify(TOOL_BRIDGE_TOOLS_PATH)};
const REQUEST_PATH = ${JSON.stringify(TOOL_BRIDGE_REQUEST_PATH)};
const RESPONSE_PATH = ${JSON.stringify(TOOL_BRIDGE_RESPONSE_PATH)};
const PENDING_PATH = ${JSON.stringify(TOOL_BRIDGE_PENDING_PATH)};

let tools = [];
try { tools = JSON.parse(readFileSync(TOOLS_PATH, 'utf8')); } catch {}

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  const buf = Buffer.from(msg, 'utf8');
  process.stdout.write('Content-Length: ' + buf.length + '\\r\\n\\r\\n');
  process.stdout.write(buf);
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  const buf = Buffer.from(msg, 'utf8');
  process.stdout.write('Content-Length: ' + buf.length + '\\r\\n\\r\\n');
  process.stdout.write(buf);
}

function handleRequest(req) {
  if (req.method === 'initialize') {
    sendResponse(req.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'tool-bridge', version: '1.0.0' },
    });
    return;
  }
  if (req.method === 'notifications/initialized') return;
  if (req.method === 'tools/list') {
    sendResponse(req.id, {
      tools: tools.map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.input_schema || { type: 'object', properties: {} },
      })),
    });
    return;
  }
  if (req.method === 'tools/call') {
    const toolName = req.params?.name;
    const toolInput = req.params?.arguments || {};

    // Replay case: if response.json already exists (from a --resume re-entry),
    // return it immediately without creating a pending sentinel.
    if (existsSync(RESPONSE_PATH)) {
      try {
        const resp = JSON.parse(readFileSync(RESPONSE_PATH, 'utf8'));
        sendResponse(req.id, {
          content: [{ type: 'text', text: JSON.stringify(resp.content ?? resp) }],
          isError: false,
        });
        try { unlinkSync(RESPONSE_PATH); } catch {}
        return;
      } catch (e) {
        console.error('[tool-bridge] replay failed:', e);
        process.exit(1);
      }
    }

    // Write the request and create pending sentinel
    writeFileSync(REQUEST_PATH, JSON.stringify({
      tool_use_id: req.id,
      name: toolName,
      input: toolInput,
    }));
    writeFileSync(PENDING_PATH, '');

    // Watch for response.json — prefer fs.watch (inotify/kqueue) over
    // fs.watchFile (stat polling). Fall back to watchFile if watch fails.
    let resolved = false;
    const onResponse = () => {
      if (resolved) return;
      if (!existsSync(RESPONSE_PATH)) return;
      resolved = true;
      // Clean up whichever watcher is active
      if (watcher) { try { watcher.close(); } catch {} }
      try { unwatchFile(RESPONSE_PATH, pollFallback); } catch {}
      try {
        const resp = JSON.parse(readFileSync(RESPONSE_PATH, 'utf8'));
        try { unlinkSync(RESPONSE_PATH); } catch {}
        try { unlinkSync(PENDING_PATH); } catch {}
        sendResponse(req.id, {
          content: [{ type: 'text', text: JSON.stringify(resp.content ?? resp) }],
          isError: false,
        });
      } catch (e) {
        sendError(req.id, -32603, 'Failed to read response: ' + e.message);
      }
    };
    const pollFallback = () => onResponse();
    let watcher = null;
    // Check immediately in case it was written between our existsSync check
    onResponse();
    if (resolved) return;
    try {
      watcher = watch(RESPONSE_PATH, () => onResponse());
      watcher.on('error', () => {
        // fs.watch failed mid-watch — fall back to polling
        try { watcher.close(); } catch {}
        watcher = null;
        watchFile(RESPONSE_PATH, { interval: 200 }, pollFallback);
      });
    } catch {
      // fs.watch not available — fall back to stat polling
      watchFile(RESPONSE_PATH, { interval: 200 }, pollFallback);
    }
    return;
  }
  // Unknown method
  if (req.id != null) {
    sendError(req.id, -32601, 'Method not found: ' + req.method);
  }
}

// Read MCP stdio protocol: Content-Length headers + JSON body
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;
    const body = buffer.slice(bodyStart, bodyStart + len);
    buffer = buffer.slice(bodyStart + len);
    try {
      handleRequest(JSON.parse(body));
    } catch {}
  }
});
process.stdin.on('end', () => process.exit(0));
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
      type: "stdio",
      command: "node",
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
