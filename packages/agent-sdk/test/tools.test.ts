import { describe, it, expect } from "vitest";
import { resolveToolset } from "../src/sessions/tools";

describe("resolveToolset", () => {
  it("enables the full built-in set when agent_toolset is declared with defaults", () => {
    const r = resolveToolset([{ type: "agent_toolset_20260401" }]);
    expect(r.allowedTools).toEqual([
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "ToolSearch",
      "Skill",
      "Agent",
      "NotebookEdit",
      "TodoWrite",
    ]);
    expect(r.disallowedTools).toEqual([]);
    expect(r.customToolNames.size).toBe(0);
  });

  it("honors configs[].enabled=false as a subtract", () => {
    const r = resolveToolset([
      {
        type: "agent_toolset_20260401",
        configs: [
          { name: "WebFetch", enabled: false },
          { name: "WebSearch", enabled: false },
        ],
      },
    ]);
    expect(r.allowedTools).toContain("Bash");
    expect(r.allowedTools).not.toContain("WebFetch");
    expect(r.disallowedTools).toEqual(["WebFetch", "WebSearch"]);
  });

  it("honors default_config.enabled=false as invert", () => {
    const r = resolveToolset([
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: false },
        configs: [
          { name: "Bash", enabled: true },
          { name: "Read", enabled: true },
        ],
      },
    ]);
    expect(r.allowedTools.sort()).toEqual(["Bash", "Read"]);
  });

  it("collects custom tool names and ignores them from built-ins", () => {
    const r = resolveToolset([
      { type: "agent_toolset_20260401" },
      {
        type: "custom",
        name: "get_weather",
        description: "get weather",
        input_schema: { type: "object" },
      },
    ]);
    expect(r.customToolNames.has("get_weather")).toBe(true);
    expect(r.allowedTools).toContain("Bash");
  });

  it("allows only ToolSearch when agent_toolset is absent + custom tools present", () => {
    const r = resolveToolset([
      {
        type: "custom",
        name: "foo",
        description: "x",
        input_schema: {},
      },
    ]);
    // ToolSearch is always allowed when custom tools are present —
    // Claude Code uses it as the MCP-tool discovery fallback while
    // MCP servers transition from "pending" → "ready" (0.5.54).
    expect(r.allowedTools).toEqual(["ToolSearch"]);
    expect(r.customToolNames.has("foo")).toBe(true);
  });

  it("normalizes lowercase tool names to PascalCase", () => {
    const r = resolveToolset([
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: false },
        configs: [
          { name: "read", enabled: true },
          { name: "bash", enabled: true },
        ],
      },
    ]);
    expect(r.allowedTools.sort()).toEqual(["Bash", "Read"]);
    expect(r.disallowedTools).toContain("Write");
    expect(r.disallowedTools).toContain("ToolSearch");
    expect(r.disallowedTools).not.toContain("Bash");
    expect(r.disallowedTools).not.toContain("Read");
  });

  it("normalizes official snake_case names (web_fetch/web_search → WebFetch/WebSearch)", () => {
    const r = resolveToolset([
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: true },
        configs: [
          { name: "web_fetch", enabled: false },
          { name: "web_search", enabled: false },
        ],
      },
    ]);
    expect(r.disallowedTools).toContain("WebFetch"); // was silently ignored before the underscore fix
    expect(r.disallowedTools).toContain("WebSearch");
    expect(r.allowedTools).not.toContain("WebFetch");
    expect(r.allowedTools).toContain("Bash"); // others unaffected
  });

  it("normalizes mixed-case tool names", () => {
    const r = resolveToolset([
      {
        type: "agent_toolset_20260401",
        configs: [
          { name: "webfetch", enabled: false },
          { name: "WEBSEARCH", enabled: false },
          { name: "toolsearch", enabled: false },
        ],
      },
    ]);
    expect(r.allowedTools).toContain("Bash");
    expect(r.allowedTools).not.toContain("WebFetch");
    expect(r.allowedTools).not.toContain("WebSearch");
    expect(r.allowedTools).not.toContain("ToolSearch");
    expect(r.disallowedTools).toContain("WebFetch");
    expect(r.disallowedTools).toContain("WebSearch");
    expect(r.disallowedTools).toContain("ToolSearch");
  });

  it("ignores unknown tool names even after normalization", () => {
    const r = resolveToolset([
      {
        type: "agent_toolset_20260401",
        configs: [
          { name: "nonexistent_tool", enabled: false },
        ],
      },
    ]);
    // All built-ins still enabled — unknown name is skipped
    expect(r.allowedTools).toContain("Bash");
    expect(r.allowedTools).toContain("Read");
    expect(r.disallowedTools).toEqual([]);
  });

  // Regression: agents created without an explicit tools config ended up with
  // tools: [], which hit this "no toolset declared" branch and disabled every
  // built-in. The wizard fix is to send agent_toolset_20260401 explicitly —
  // this test locks in the empty-array behavior so callers know they must
  // opt in.
  it("returns no built-ins when tools is empty array", () => {
    const r = resolveToolset([]);
    expect(r.allowedTools).toEqual([]);
    expect(r.disallowedTools).toEqual([
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "ToolSearch",
      "Skill",
      "Agent",
      "NotebookEdit",
      "TodoWrite",
    ]);
    expect(r.customToolNames.size).toBe(0);
  });
});
