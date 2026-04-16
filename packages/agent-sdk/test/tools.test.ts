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

  it("returns no built-ins when agent_toolset is absent", () => {
    const r = resolveToolset([
      {
        type: "custom",
        name: "foo",
        description: "x",
        input_schema: {},
      },
    ]);
    expect(r.allowedTools).toEqual([]);
    expect(r.customToolNames.has("foo")).toBe(true);
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
    ]);
    expect(r.customToolNames.size).toBe(0);
  });
});
