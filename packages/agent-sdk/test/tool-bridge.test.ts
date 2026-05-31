/**
 * Tests for the tool bridge: both the bash script (MCP stdio server) and
 * the driver's request.json parsing logic.
 *
 * The bash script tests run the actual generated script via child_process,
 * writing MCP JSON-RPC messages to stdin and verifying what gets written
 * to request.json and returned on stdout.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync, spawn } from "child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  generateBridgeScript,
  toolsToJson,
  buildBridgeMcpConfig,
} from "../src/backends/claude/tool-bridge";

// ---------------------------------------------------------------------------
// Helper: normalize MCP request (mirrors the driver's logic from driver.ts ~L1246)
// ---------------------------------------------------------------------------
function normalizeRequest(raw: Record<string, unknown>): {
  tool_use_id: string;
  name: string;
  input: unknown;
} {
  if (raw.params && typeof raw.params === "object") {
    const params = raw.params as Record<string, unknown>;
    return {
      tool_use_id: String(raw.id ?? ""),
      name: (params.name as string) ?? "",
      input: params.arguments ?? {},
    };
  }
  // Legacy format
  return {
    tool_use_id: String((raw as Record<string, unknown>).tool_use_id ?? ""),
    name: String((raw as Record<string, unknown>).name ?? ""),
    input: (raw as Record<string, unknown>).input ?? {},
  };
}

// ---------------------------------------------------------------------------
// Driver request parsing tests
// ---------------------------------------------------------------------------
describe("tool bridge request parsing (driver normalizer)", () => {
  it("parses MCP envelope with simple arguments", () => {
    const raw = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "save_output",
        arguments: { key: "value" },
      },
    };
    const req = normalizeRequest(raw as Record<string, unknown>);
    expect(req.tool_use_id).toBe("1");
    expect(req.name).toBe("save_output");
    expect(req.input).toEqual({ key: "value" });
  });

  it("parses MCP envelope with nested arguments", () => {
    const raw = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "deploy",
        arguments: { data: { nested: { deep: true, array: [1, 2, 3] } } },
      },
    };
    const req = normalizeRequest(raw as Record<string, unknown>);
    expect(req.tool_use_id).toBe("2");
    expect(req.name).toBe("deploy");
    expect(req.input).toEqual({
      data: { nested: { deep: true, array: [1, 2, 3] } },
    });
  });

  it("parses MCP envelope with string containing braces", () => {
    const raw = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "save_output",
        arguments: { text: "hello {world} {foo}" },
      },
    };
    const req = normalizeRequest(raw as Record<string, unknown>);
    expect(req.name).toBe("save_output");
    expect(req.input).toEqual({ text: "hello {world} {foo}" });
  });

  it("parses MCP envelope with empty arguments", () => {
    const raw = {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "ping_tool",
        arguments: {},
      },
    };
    const req = normalizeRequest(raw as Record<string, unknown>);
    expect(req.tool_use_id).toBe("4");
    expect(req.name).toBe("ping_tool");
    expect(req.input).toEqual({});
  });

  it("parses MCP envelope with no arguments key — defaults input to {}", () => {
    const raw = {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "no_args_tool",
      },
    };
    const req = normalizeRequest(raw as Record<string, unknown>);
    expect(req.tool_use_id).toBe("5");
    expect(req.name).toBe("no_args_tool");
    expect(req.input).toEqual({});
  });

  it("parses legacy format", () => {
    const raw = {
      tool_use_id: "abc-123",
      name: "save_output",
      input: { key: "value" },
    };
    const req = normalizeRequest(raw as Record<string, unknown>);
    expect(req.tool_use_id).toBe("abc-123");
    expect(req.name).toBe("save_output");
    expect(req.input).toEqual({ key: "value" });
  });

  it("parses MCP envelope with string id", () => {
    const raw = {
      jsonrpc: "2.0",
      id: "req-abc-123",
      method: "tools/call",
      params: {
        name: "my_tool",
        arguments: { x: 1 },
      },
    };
    const req = normalizeRequest(raw as Record<string, unknown>);
    expect(req.tool_use_id).toBe("req-abc-123");
    expect(req.name).toBe("my_tool");
    expect(req.input).toEqual({ x: 1 });
  });

  it("parses MCP envelope with large nested arguments (10KB+)", () => {
    // Build a ~12KB nested structure
    const bigArray: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      bigArray.push({
        index: i,
        data: `item-${i}-${"x".repeat(40)}`,
        nested: { a: i, b: [i, i + 1, i + 2] },
      });
    }
    const raw = {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: {
        name: "bulk_upload",
        arguments: { items: bigArray },
      },
    };
    const jsonStr = JSON.stringify(raw);
    expect(jsonStr.length).toBeGreaterThan(10000);

    const req = normalizeRequest(raw as Record<string, unknown>);
    expect(req.tool_use_id).toBe("99");
    expect(req.name).toBe("bulk_upload");
    const input = req.input as { items: unknown[] };
    expect(input.items).toHaveLength(200);
    expect(input.items[0]).toEqual({
      index: 0,
      data: `item-0-${"x".repeat(40)}`,
      nested: { a: 0, b: [0, 1, 2] },
    });
  });

  it("handles arguments with special characters — newlines, quotes, unicode, backslashes", () => {
    const raw = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "write_file",
        arguments: {
          content: 'line1\nline2\n"quoted"\ttab\\backslash',
          emoji: "\u{1F600}\u{1F680}",
          path: "C:\\Users\\test\\file.txt",
        },
      },
    };
    const req = normalizeRequest(raw as Record<string, unknown>);
    expect(req.name).toBe("write_file");
    const input = req.input as Record<string, string>;
    expect(input.content).toBe('line1\nline2\n"quoted"\ttab\\backslash');
    expect(input.emoji).toBe("\u{1F600}\u{1F680}");
    expect(input.path).toBe("C:\\Users\\test\\file.txt");
  });

  it("handles arguments with arrays", () => {
    const raw = {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "multi_select",
        arguments: {
          items: [1, "two", { nested: true }, [3, 4]],
          tags: ["a", "b", "c"],
        },
      },
    };
    const req = normalizeRequest(raw as Record<string, unknown>);
    expect(req.name).toBe("multi_select");
    expect(req.input).toEqual({
      items: [1, "two", { nested: true }, [3, 4]],
      tags: ["a", "b", "c"],
    });
  });

  it("handles MCP envelope with null id — null is nullish so ?? yields empty string", () => {
    const raw = {
      jsonrpc: "2.0",
      id: null,
      method: "tools/call",
      params: {
        name: "fire_and_forget",
        arguments: { data: "test" },
      },
    };
    const req = normalizeRequest(raw as Record<string, unknown>);
    // null ?? "" → "" because null is nullish
    expect(req.tool_use_id).toBe("");
    expect(req.name).toBe("fire_and_forget");
  });

  it("handles MCP envelope with numeric zero id", () => {
    const raw = {
      jsonrpc: "2.0",
      id: 0,
      method: "tools/call",
      params: {
        name: "tool_zero",
        arguments: {},
      },
    };
    const req = normalizeRequest(raw as Record<string, unknown>);
    // 0 is not nullish, so String(0) → "0"
    expect(req.tool_use_id).toBe("0");
    expect(req.name).toBe("tool_zero");
  });
});

// ---------------------------------------------------------------------------
// toolsToJson / buildBridgeMcpConfig unit tests
// ---------------------------------------------------------------------------
describe("toolsToJson", () => {
  it("converts CustomTool array to JSON string", () => {
    const tools = [
      {
        type: "custom" as const,
        name: "save_output",
        description: "Save output to a file",
        input_schema: {
          type: "object",
          properties: { filename: { type: "string" } },
          required: ["filename"],
        },
      },
    ];
    const json = toolsToJson(tools);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("save_output");
    expect(parsed[0].description).toBe("Save output to a file");
    expect(parsed[0].input_schema.properties.filename.type).toBe("string");
  });

  it("handles empty tool array", () => {
    const json = toolsToJson([]);
    expect(JSON.parse(json)).toEqual([]);
  });
});

describe("buildBridgeMcpConfig", () => {
  it("adds tool-bridge server to existing servers", () => {
    const existing = { "my-server": { command: "node", args: ["server.js"] } };
    const config = buildBridgeMcpConfig(existing);
    expect(config["my-server"]).toEqual({
      command: "node",
      args: ["server.js"],
    });
    expect(config["tool-bridge"]).toEqual({
      command: "bash",
      args: ["/tmp/tool-bridge/bridge.sh"],
    });
  });

  it("works with empty existing servers", () => {
    const config = buildBridgeMcpConfig({});
    expect(Object.keys(config)).toEqual(["tool-bridge"]);
  });
});

// ---------------------------------------------------------------------------
// Bash script integration tests
// ---------------------------------------------------------------------------
describe("tool bridge bash script", () => {
  let tmpDir: string;
  let scriptPath: string;
  let bridgeDir: string;
  let requestPath: string;
  let responsePath: string;
  let pendingPath: string;
  let toolsPath: string;

  const hasBash = (() => {
    try {
      execSync("bash --version", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tool-bridge-test-"));
    bridgeDir = join(tmpDir, "tool-bridge");
    mkdirSync(bridgeDir, { recursive: true });

    scriptPath = join(bridgeDir, "bridge.sh");
    requestPath = join(bridgeDir, "request.json");
    responsePath = join(bridgeDir, "response.json");
    pendingPath = join(bridgeDir, "pending");
    toolsPath = join(bridgeDir, "tools.json");

    // Generate the script and rewrite hardcoded paths to our temp dir
    let script = generateBridgeScript();
    script = script.replace(
      /\/tmp\/tool-bridge/g,
      bridgeDir,
    );
    writeFileSync(scriptPath, script, { mode: 0o755 });

    // Write a tools.json with test tools
    const testTools = [
      {
        name: "save_output",
        description: "Save output to a file",
        input_schema: {
          type: "object",
          properties: {
            filename: { type: "string" },
            content_text: { type: "string" },
          },
          required: ["filename"],
        },
      },
      {
        name: "get_data",
        description: "Fetch data",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ];
    writeFileSync(toolsPath, JSON.stringify(testTools));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean up per-test state files
    for (const f of [requestPath, responsePath, pendingPath]) {
      if (existsSync(f)) rmSync(f);
    }
  });

  /**
   * Helper: send a single JSON-RPC line to the bridge script and capture
   * stdout. For non-blocking methods (initialize, ping, tools/list) this
   * works synchronously since stdin closes and the script exits.
   */
  function sendToScript(message: string): string {
    try {
      const result = execSync(
        `echo '${message.replace(/'/g, "'\\''")}' | bash "${scriptPath}"`,
        {
          cwd: tmpDir,
          timeout: 5000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      return result.trim();
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      if (e.stdout) return e.stdout.trim();
      throw err;
    }
  }

  /**
   * Helper: run a tools/call through the bash script asynchronously.
   * Spawns the script, writes the message to stdin, waits for pending
   * sentinel to appear (proving request.json was written), then writes
   * response.json so the script unblocks. Returns stdout output.
   */
  function sendToolsCall(
    message: string,
    responseContent: string,
    opts?: { timeout?: number },
  ): Promise<{ stdout: string; requestJson: Record<string, unknown> | null }> {
    return new Promise((resolve, reject) => {
      const timeout = opts?.timeout ?? 10000;
      let stdout = "";
      let timedOut = false;

      const proc = spawn("bash", [scriptPath], {
        cwd: tmpDir,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
        reject(new Error(`tools/call timed out after ${timeout}ms`));
      }, timeout);

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.on("close", () => {
        if (timedOut) return;
        clearTimeout(timer);

        let requestJson: Record<string, unknown> | null = null;
        if (existsSync(requestPath)) {
          try {
            requestJson = JSON.parse(readFileSync(requestPath, "utf-8"));
          } catch {
            // ignore parse errors
          }
        }
        resolve({ stdout: stdout.trim(), requestJson });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      // Write the message to stdin then close it so the read loop ends
      // after processing this one message
      proc.stdin.write(message + "\n");
      proc.stdin.end();

      // Poll for pending sentinel, then write response
      const pollInterval = setInterval(() => {
        if (existsSync(pendingPath)) {
          clearInterval(pollInterval);
          writeFileSync(responsePath, responseContent);
        }
      }, 50);

      // Clean up polling on close
      proc.on("close", () => {
        clearInterval(pollInterval);
      });
    });
  }

  /**
   * Helper: send raw bytes (for Content-Length framing tests)
   */
  function sendRawToScript(input: Buffer | string): string {
    const inputFile = join(tmpDir, "stdin.bin");
    writeFileSync(inputFile, input);
    try {
      const result = execSync(`bash "${scriptPath}" < "${inputFile}"`, {
        cwd: tmpDir,
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return result.trim();
    } catch (err: unknown) {
      const e = err as { stdout?: string };
      if (e.stdout) return e.stdout.trim();
      throw err;
    }
  }

  it.skipIf(!hasBash)("echoes client protocolVersion in initialize response", () => {
    // Per 0.5.53: bridge echoes the client's protocolVersion (MCP spec)
    // instead of hardcoding a single version. Claude Code 2.x sends
    // various versions over the beta lifetime; echoing keeps the
    // handshake compatible across releases.
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    const output = sendToScript(msg);
    const resp = JSON.parse(output);
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(1);
    expect(resp.result.protocolVersion).toBe("2025-11-25");
    expect(resp.result.capabilities.tools).toBeDefined();
    expect(resp.result.serverInfo.name).toBe("tool-bridge");
  });

  it.skipIf(!hasBash)("falls back to 2024-11-05 when client omits protocolVersion", () => {
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {},
    });
    const output = sendToScript(msg);
    const resp = JSON.parse(output);
    expect(resp.result.protocolVersion).toBe("2024-11-05");
  });

  it.skipIf(!hasBash)("handles ping request", () => {
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "ping",
    });
    const output = sendToScript(msg);
    const resp = JSON.parse(output);
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(42);
    expect(resp.result).toEqual({});
  });

  it.skipIf(!hasBash)("handles tools/list request", () => {
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const output = sendToScript(msg);
    const resp = JSON.parse(output);
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(2);
    // tools.json uses input_schema but the script converts to inputSchema
    const tools = resp.result.tools;
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("save_output");
    expect(tools[0].inputSchema).toBeDefined();
    expect(tools[1].name).toBe("get_data");
  });

  it.skipIf(!hasBash)(
    "writes full MCP body to request.json on tools/call",
    async () => {
      const mcpBody = {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "save_output",
          arguments: { filename: "test.txt", content_text: "hello world" },
        },
      };
      const { requestJson } = await sendToolsCall(
        JSON.stringify(mcpBody),
        "OK",
      );

      expect(requestJson).not.toBeNull();
      expect(requestJson!.jsonrpc).toBe("2.0");
      expect(requestJson!.id).toBe(10);
      expect(requestJson!.method).toBe("tools/call");
      const params = requestJson!.params as Record<string, unknown>;
      expect(params.name).toBe("save_output");
      expect(params.arguments).toEqual({
        filename: "test.txt",
        content_text: "hello world",
      });
    },
  );

  it.skipIf(!hasBash)(
    "preserves nested braces in arguments (the truncation bug)",
    async () => {
      const mcpBody = {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "save_output",
          arguments: {
            filename: "data.json",
            content_text: JSON.stringify({
              outer: { inner: { deep: "value" } },
              array: [{ a: 1 }, { b: 2 }],
            }),
          },
        },
      };
      const { requestJson } = await sendToolsCall(
        JSON.stringify(mcpBody),
        "saved",
      );

      expect(requestJson).not.toBeNull();
      const params = requestJson!.params as Record<string, unknown>;
      const args = params.arguments as Record<string, string>;
      expect(args.filename).toBe("data.json");
      const parsedContent = JSON.parse(args.content_text);
      expect(parsedContent.outer.inner.deep).toBe("value");
      expect(parsedContent.array).toEqual([{ a: 1 }, { b: 2 }]);
    },
  );

  it.skipIf(!hasBash)("rejects unknown tool with isError true", () => {
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "nonexistent_tool",
        arguments: {},
      },
    });
    const output = sendToScript(msg);
    const resp = JSON.parse(output);
    expect(resp.id).toBe(20);
    expect(resp.result.isError).toBe(true);
    expect(resp.result.content[0].text).toContain("Unknown tool");
    expect(resp.result.content[0].text).toContain("nonexistent_tool");
  });

  it.skipIf(!hasBash)("returns unknown method error for unsupported methods", () => {
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      id: 30,
      method: "resources/list",
      params: {},
    });
    const output = sendToScript(msg);
    const resp = JSON.parse(output);
    expect(resp.id).toBe(30);
    expect(resp.error.code).toBe(-32601);
    expect(resp.error.message).toBe("Method not found");
  });

  it.skipIf(!hasBash)("ignores notification methods (no response)", () => {
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    const output = sendToScript(msg);
    // Notifications produce no output
    expect(output).toBe("");
  });

  it.skipIf(!hasBash)(
    "returns response.json content in tools/call result",
    async () => {
      const responseContent = '{"status":"success","data":42}';
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: {
          name: "save_output",
          arguments: { filename: "test.txt" },
        },
      });
      const { stdout } = await sendToolsCall(msg, responseContent);
      const resp = JSON.parse(stdout);
      expect(resp.id).toBe(40);
      expect(resp.result.isError).toBe(false);
      expect(resp.result.content).toHaveLength(1);
      expect(resp.result.content[0].type).toBe("text");
      expect(resp.result.content[0].text).toContain("success");
    },
  );

  it.skipIf(!hasBash)(
    "creates pending sentinel and request.json during tools/call",
    async () => {
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: {
          name: "save_output",
          arguments: { filename: "x" },
        },
      });
      // sendToolsCall polls for pending sentinel — if it finds it, the test passes
      const { requestJson } = await sendToolsCall(msg, "done");
      expect(requestJson).not.toBeNull();
      expect((requestJson!.params as Record<string, unknown>).name).toBe("save_output");
    },
  );

  it.skipIf(!hasBash)(
    "handles replay case — pre-existing response.json before request is written",
    () => {
      // The replay scenario: response.json already exists when tools/call arrives
      // (e.g., --resume re-entry). The script should return it immediately without
      // writing request.json.
      writeFileSync(responsePath, "replay-data");

      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id: 60,
        method: "tools/call",
        params: {
          name: "save_output",
          arguments: { filename: "replay.txt" },
        },
      });
      const output = sendToScript(msg);
      const resp = JSON.parse(output);
      expect(resp.id).toBe(60);
      expect(resp.result.isError).toBe(false);
      expect(resp.result.content[0].text).toContain("replay-data");

      // In replay case, request.json should NOT be written
      expect(existsSync(requestPath)).toBe(false);
    },
  );

  it.skipIf(!hasBash)(
    "handles Content-Length framed input",
    () => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 70,
        method: "ping",
      });
      const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      const output = sendRawToScript(framed);
      const resp = JSON.parse(output);
      expect(resp.id).toBe(70);
      expect(resp.result).toEqual({});
    },
  );

  it.skipIf(!hasBash)(
    "handles MCP handshake: initialize + notifications/initialized + tools/list",
    () => {
      const messages = [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      ].join("\n");

      const inputFile = join(tmpDir, "handshake.txt");
      writeFileSync(inputFile, messages + "\n");

      let output: string;
      try {
        output = execSync(`bash "${scriptPath}" < "${inputFile}"`, {
          cwd: tmpDir,
          timeout: 5000,
          encoding: "utf-8",
        }).trim();
      } catch (err: unknown) {
        const e = err as { stdout?: string };
        output = (e.stdout ?? "").trim();
      }

      const lines = output.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2);

      // First response: initialize
      const initResp = JSON.parse(lines[0]);
      expect(initResp.id).toBe(1);
      expect(initResp.result.serverInfo.name).toBe("tool-bridge");

      // Second response: tools/list (notification produces no output)
      const listResp = JSON.parse(lines[1]);
      expect(listResp.id).toBe(2);
      expect(listResp.result.tools).toHaveLength(2);
    },
  );

  it.skipIf(!hasBash)(
    "writes valid JSON to request.json for arguments with deeply nested objects",
    async () => {
      // NOTE: avoid using "name" as a key inside arguments — the bash script
      // extracts tool_name via grep '"name":"[^"]*"' | tail -1, so a "name"
      // field in arguments would shadow the actual tool name.
      const deepArgs = {
        config: {
          database: {
            host: "localhost",
            port: 5432,
            options: {
              ssl: { enabled: true, cert: "/path/to/cert" },
              pool: { min: 2, max: 10 },
            },
          },
          features: [
            { label: "auth", settings: { provider: "oauth", scopes: ["read", "write"] } },
            { label: "cache", settings: { ttl: 300, strategy: "lru" } },
          ],
        },
      };
      const mcpBody = {
        jsonrpc: "2.0",
        id: 80,
        method: "tools/call",
        params: { name: "save_output", arguments: deepArgs },
      };
      const { requestJson } = await sendToolsCall(
        JSON.stringify(mcpBody),
        "ok",
      );

      expect(requestJson).not.toBeNull();
      const params = requestJson!.params as Record<string, unknown>;
      expect(params.arguments).toEqual(deepArgs);
    },
  );

  it.skipIf(!hasBash)(
    "handles arguments with curly braces in string values",
    async () => {
      const mcpBody = {
        jsonrpc: "2.0",
        id: 90,
        method: "tools/call",
        params: {
          name: "save_output",
          arguments: {
            filename: "template.txt",
            content_text: "Hello {{name}}, your balance is ${amount}. Use {braces} freely.",
          },
        },
      };
      const { requestJson } = await sendToolsCall(
        JSON.stringify(mcpBody),
        "ok",
      );

      expect(requestJson).not.toBeNull();
      const params = requestJson!.params as Record<string, unknown>;
      const args = params.arguments as Record<string, string>;
      expect(args.content_text).toBe(
        "Hello {{name}}, your balance is ${amount}. Use {braces} freely.",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// generateBridgeScript() output validation
// ---------------------------------------------------------------------------
describe("generateBridgeScript", () => {
  it("produces a valid bash script starting with shebang", () => {
    const script = generateBridgeScript();
    expect(script.startsWith("#!/bin/bash")).toBe(true);
  });

  it("references the correct tool bridge paths", () => {
    const script = generateBridgeScript();
    expect(script).toContain("/tmp/tool-bridge/tools.json");
    expect(script).toContain("/tmp/tool-bridge/request.json");
    expect(script).toContain("/tmp/tool-bridge/response.json");
    expect(script).toContain("/tmp/tool-bridge/pending");
  });

  it("contains handle_request function", () => {
    const script = generateBridgeScript();
    expect(script).toContain("handle_request()");
  });

  it("supports both raw JSON and Content-Length framing", () => {
    const script = generateBridgeScript();
    expect(script).toContain("Content-Length:");
    expect(script).toContain('"{"*');
  });

  it("converts input_schema to inputSchema in tools/list", () => {
    const script = generateBridgeScript();
    expect(script).toContain("input_schema/inputSchema");
  });
});
