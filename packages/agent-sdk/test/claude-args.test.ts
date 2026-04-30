import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Fresh DB for each test — getConfig reads settings from the DB
function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-args-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caConfigCache?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caConfigCache;
}

function makeAgent(overrides: Partial<import("../src/types").Agent> = {}): import("../src/types").Agent {
  return {
    id: "agent_test",
    version: 1,
    name: "test",
    model: "claude-sonnet-4-6",
    engine: "claude" as const,
    system: null,
    tools: [],
    mcp_servers: {},
    skills: [],
    webhook_url: null,
    webhook_events: [],
    webhook_signing_enabled: false,
    threads_enabled: false,
    confirmation_mode: false,
    callable_agents: [],
    model_config: {},
    fallback_json: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildClaudeArgs", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("includes MCP-namespaced custom tool names in --allowed-tools", async () => {
    const { buildClaudeArgs } = await import("../src/backends/claude/args");
    const agent = makeAgent({
      tools: [
        { type: "agent_toolset_20260401" },
        {
          type: "custom",
          name: "lookup_data",
          description: "Look up data",
          input_schema: { type: "object" },
        },
        {
          type: "custom",
          name: "save_output",
          description: "Save output",
          input_schema: { type: "object" },
        },
      ],
    });

    const argv = buildClaudeArgs({ agent });
    const allowedIdx = argv.indexOf("--allowed-tools");
    expect(allowedIdx).toBeGreaterThan(-1);
    const allowedValue = argv[allowedIdx + 1];
    expect(allowedValue).toContain("mcp__tool-bridge__lookup_data");
    expect(allowedValue).toContain("mcp__tool-bridge__save_output");
    // Built-in tools still present
    expect(allowedValue).toContain("Bash");
    expect(allowedValue).toContain("Read");
  });

  it("includes custom tool names in system prompt", async () => {
    const { buildClaudeArgs } = await import("../src/backends/claude/args");
    const agent = makeAgent({
      tools: [
        { type: "agent_toolset_20260401" },
        {
          type: "custom",
          name: "get_weather",
          description: "Get weather",
          input_schema: { type: "object" },
        },
      ],
    });

    const argv = buildClaudeArgs({ agent });
    const sysIdx = argv.indexOf("--system-prompt");
    expect(sysIdx).toBeGreaterThan(-1);
    const systemPrompt = argv[sysIdx + 1];
    expect(systemPrompt).toContain("mcp__tool-bridge__get_weather");
    expect(systemPrompt).toContain("do not use ToolSearch");
  });

  it("does not add MCP tool names when no custom tools", async () => {
    const { buildClaudeArgs } = await import("../src/backends/claude/args");
    const agent = makeAgent({
      tools: [{ type: "agent_toolset_20260401" }],
    });

    const argv = buildClaudeArgs({ agent });
    const allowedIdx = argv.indexOf("--allowed-tools");
    expect(allowedIdx).toBeGreaterThan(-1);
    const allowedValue = argv[allowedIdx + 1];
    expect(allowedValue).not.toContain("mcp__tool-bridge__");

    const sysIdx = argv.indexOf("--system-prompt");
    const systemPrompt = argv[sysIdx + 1];
    expect(systemPrompt).not.toContain("mcp__tool-bridge__");
  });

  it("includes gateway preamble in system prompt", async () => {
    const { buildClaudeArgs } = await import("../src/backends/claude/args");
    const agent = makeAgent({ system: "You are helpful." });

    const argv = buildClaudeArgs({ agent });
    const sysIdx = argv.indexOf("--system-prompt");
    const systemPrompt = argv[sysIdx + 1];
    expect(systemPrompt).toContain("You are helpful.");
    expect(systemPrompt).toContain("AgentStep sandboxed container");
    expect(systemPrompt).toContain("Execute tools directly");
  });

  it("always includes system prompt even when agent.system is null", async () => {
    const { buildClaudeArgs } = await import("../src/backends/claude/args");
    const agent = makeAgent({ system: null });

    const argv = buildClaudeArgs({ agent });
    const sysIdx = argv.indexOf("--system-prompt");
    expect(sysIdx).toBeGreaterThan(-1);
    const systemPrompt = argv[sysIdx + 1];
    expect(systemPrompt).toContain("AgentStep sandboxed container");
  });

  it("omits --max-turns when default is 0 (unlimited)", async () => {
    const { buildClaudeArgs } = await import("../src/backends/claude/args");
    const agent = makeAgent();

    const argv = buildClaudeArgs({ agent });
    expect(argv).not.toContain("--max-turns");
  });

  it("includes --max-turns when explicitly set", async () => {
    const { buildClaudeArgs } = await import("../src/backends/claude/args");
    const agent = makeAgent();

    const argv = buildClaudeArgs({ agent, maxTurns: 25 });
    const idx = argv.indexOf("--max-turns");
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe("25");
  });
});
