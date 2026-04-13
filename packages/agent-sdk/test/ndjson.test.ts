import { describe, it, expect } from "vitest";
import { parseNDJSONLines } from "../src/backends/shared/ndjson";

describe("parseNDJSONLines", () => {
  it("parses complete lines and returns the remainder", () => {
    const seen: Array<Record<string, unknown>> = [];
    const rem = parseNDJSONLines(
      `{"type":"a"}\n{"type":"b"}\n{"type":"c"`,
      (v) => seen.push(v),
    );
    expect(seen).toEqual([{ type: "a" }, { type: "b" }]);
    expect(rem).toBe('{"type":"c"');
  });

  it("ignores blank lines", () => {
    const seen: Array<Record<string, unknown>> = [];
    parseNDJSONLines(`\n\n{"x":1}\n\n`, (v) => seen.push(v));
    expect(seen).toEqual([{ x: 1 }]);
  });

  it("skips non-JSON lines silently", () => {
    const seen: Array<Record<string, unknown>> = [];
    parseNDJSONLines(`junk\n{"ok":true}\nmore junk\n`, (v) => seen.push(v));
    expect(seen).toEqual([{ ok: true }]);
  });

  it("handles incremental buffering across chunks", () => {
    const seen: Array<Record<string, unknown>> = [];
    let rem = parseNDJSONLines(`{"a":1}\n{"b":`, (v) => seen.push(v));
    expect(seen).toEqual([{ a: 1 }]);
    rem = parseNDJSONLines(rem + `2}\n`, (v) => seen.push(v));
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rem).toBe("");
  });
});
