/**
 * Tests for Pi backend argument construction, specifically model ID
 * normalization. Pi CLI expects provider-prefixed IDs like
 * "google/gemini-3.5-flash" but users pass bare IDs like "gemini-3.5-flash".
 */

import { describe, it, expect } from "vitest";
import { buildPiArgs } from "../src/backends/pi/args";
import type { Agent } from "../src/types";

function makeAgent(modelId: string): Agent {
  return {
    id: "agent_test",
    name: "test",
    version: 1,
    engine: "pi",
    model: { id: modelId },
    system: null,
    tools: [],
    mcp_servers: [],
    skills: [],
    metadata: {},
  } as unknown as Agent;
}

describe("buildPiArgs model normalization", () => {
  it("prefixes gemini-* with google/", () => {
    const args = buildPiArgs({ agent: makeAgent("gemini-3.5-flash"), backendSessionId: null, prompt: "hello" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("google/gemini-3.5-flash");
  });

  it("prefixes gemini-2.5-pro with google/", () => {
    const args = buildPiArgs({ agent: makeAgent("gemini-2.5-pro"), backendSessionId: null, prompt: "test" });
    expect(args[args.indexOf("--model") + 1]).toBe("google/gemini-2.5-pro");
  });

  it("prefixes claude-* with anthropic/", () => {
    const args = buildPiArgs({ agent: makeAgent("claude-sonnet-4-6"), backendSessionId: null, prompt: "test" });
    expect(args[args.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet-4-6");
  });

  it("prefixes gpt-* with openai/", () => {
    const args = buildPiArgs({ agent: makeAgent("gpt-5.4"), backendSessionId: null, prompt: "test" });
    expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-5.4");
  });

  it("prefixes o1-* with openai/", () => {
    const args = buildPiArgs({ agent: makeAgent("o1-preview"), backendSessionId: null, prompt: "test" });
    expect(args[args.indexOf("--model") + 1]).toBe("openai/o1-preview");
  });

  it("passes through already-prefixed models unchanged", () => {
    const args = buildPiArgs({ agent: makeAgent("google/gemini-2.5-flash"), backendSessionId: null, prompt: "test" });
    expect(args[args.indexOf("--model") + 1]).toBe("google/gemini-2.5-flash");
  });

  it("passes through unknown model names unchanged", () => {
    const args = buildPiArgs({ agent: makeAgent("llama-3.1-70b"), backendSessionId: null, prompt: "test" });
    expect(args[args.indexOf("--model") + 1]).toBe("llama-3.1-70b");
  });

  it("includes -p, --mode json, --no-extensions flags", () => {
    const args = buildPiArgs({ agent: makeAgent("gemini-3.5-flash"), backendSessionId: null, prompt: "hello" });
    expect(args).toContain("-p");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("json");
    expect(args).toContain("--no-extensions");
  });

  it("adds --session when backendSessionId is provided", () => {
    const args = buildPiArgs({ agent: makeAgent("gemini-3.5-flash"), backendSessionId: "abc-123", prompt: "hello" });
    expect(args).toContain("--session");
    expect(args[args.indexOf("--session") + 1]).toBe("abc-123");
  });

  it("prompt is the last positional argument", () => {
    const args = buildPiArgs({ agent: makeAgent("gemini-3.5-flash"), backendSessionId: null, prompt: "do the thing" });
    expect(args[args.length - 1]).toBe("do the thing");
  });
});
