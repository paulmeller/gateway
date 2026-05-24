/**
 * Tests for model-engine inference and validation.
 *
 * When a user creates an agent with model "gemini-3.5-flash" but doesn't
 * specify engine, the system should auto-infer engine: "gemini" rather
 * than defaulting to "claude" and routing to Anthropic.
 */

import { describe, it, expect } from "vitest";
import { inferEngineFromModel, isValidModelForEngine } from "../src/backends/models";

describe("inferEngineFromModel", () => {
  it("infers gemini for gemini-* models", () => {
    expect(inferEngineFromModel("gemini-3.5-flash")).toBe("gemini");
    expect(inferEngineFromModel("gemini-2.5-pro")).toBe("gemini");
    expect(inferEngineFromModel("gemini-2.0-flash")).toBe("gemini");
  });

  it("infers gemini for google/ prefixed models", () => {
    expect(inferEngineFromModel("google/gemini-2.5-flash")).toBe("gemini");
  });

  it("infers claude for claude-* models", () => {
    expect(inferEngineFromModel("claude-sonnet-4-6")).toBe("claude");
    expect(inferEngineFromModel("claude-opus-4-6")).toBe("claude");
    expect(inferEngineFromModel("claude-haiku-4-5")).toBe("claude");
  });

  it("infers claude for anthropic/ prefixed models", () => {
    expect(inferEngineFromModel("anthropic/claude-sonnet-4-6")).toBe("claude");
  });

  it("infers codex for gpt-* models", () => {
    expect(inferEngineFromModel("gpt-5.4")).toBe("codex");
    expect(inferEngineFromModel("gpt-5.4-mini")).toBe("codex");
  });

  it("infers codex for o1/o3/o4 models", () => {
    expect(inferEngineFromModel("o1-preview")).toBe("codex");
    expect(inferEngineFromModel("o3-mini")).toBe("codex");
    expect(inferEngineFromModel("o4-mini")).toBe("codex");
  });

  it("infers codex for codex-* models", () => {
    expect(inferEngineFromModel("codex-mini-latest")).toBe("codex");
  });

  it("infers codex for openai/ prefixed models", () => {
    expect(inferEngineFromModel("openai/gpt-5.4")).toBe("codex");
  });

  it("returns null for unknown model prefixes", () => {
    expect(inferEngineFromModel("llama-3.1-70b")).toBeNull();
    expect(inferEngineFromModel("mixtral-8x7b")).toBeNull();
    expect(inferEngineFromModel("my-custom-model")).toBeNull();
  });
});

describe("inferEngineFromModel + isValidModelForEngine integration", () => {
  it("inferred engine always validates the model", () => {
    const cases = [
      "gemini-3.5-flash",
      "gemini-2.5-pro",
      "claude-sonnet-4-6",
      "gpt-5.4",
      "codex-mini-latest",
    ];
    for (const model of cases) {
      const engine = inferEngineFromModel(model);
      expect(engine, `should infer engine for ${model}`).not.toBeNull();
      expect(
        isValidModelForEngine(engine!, model),
        `${model} should be valid for inferred engine ${engine}`,
      ).toBe(true);
    }
  });

  it("cross-engine validation fails for gemini model on claude engine", () => {
    expect(isValidModelForEngine("claude", "gemini-3.5-flash")).toBe(false);
  });

  it("cross-engine validation fails for claude model on gemini engine", () => {
    expect(isValidModelForEngine("gemini", "claude-sonnet-4-6")).toBe(false);
  });
});
