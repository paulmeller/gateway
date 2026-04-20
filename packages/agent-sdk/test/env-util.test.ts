/**
 * Tests for util/env.ts — .env file manipulation helpers.
 *
 * Uses real filesystem in temp directories. No mocking.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { readEnvValue, upsertEnvLine, ensureEnvLine, findDuplicateKeys } from "../src/util/env";

let tmpDir: string;
let envPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-util-test-"));
  envPath = path.join(tmpDir, ".env");
});

// ── readEnvValue ──────────────────────────────────────────────────────

describe("readEnvValue", () => {
  it("returns undefined when file doesn't exist", () => {
    expect(readEnvValue(envPath, "FOO")).toBeUndefined();
  });

  it("returns undefined when key not present", () => {
    fs.writeFileSync(envPath, "BAR=123\n");
    expect(readEnvValue(envPath, "FOO")).toBeUndefined();
  });

  it("returns the value when key exists", () => {
    fs.writeFileSync(envPath, "FOO=hello\n");
    expect(readEnvValue(envPath, "FOO")).toBe("hello");
  });

  it("returns the LAST value when key is duplicated", () => {
    fs.writeFileSync(envPath, "FOO=first\nFOO=second\n");
    expect(readEnvValue(envPath, "FOO")).toBe("second");
  });

  it("handles export KEY=val syntax", () => {
    fs.writeFileSync(envPath, "export MY_KEY=exported_val\n");
    expect(readEnvValue(envPath, "MY_KEY")).toBe("exported_val");
  });

  it("handles quoted values", () => {
    fs.writeFileSync(envPath, 'FOO="quoted value"\n');
    expect(readEnvValue(envPath, "FOO")).toBe("quoted value");
  });

  it("ignores commented-out lines", () => {
    fs.writeFileSync(envPath, "# FOO=commented\nFOO=real\n");
    expect(readEnvValue(envPath, "FOO")).toBe("real");
  });

  it("returns undefined when only commented out", () => {
    fs.writeFileSync(envPath, "# FOO=commented\n");
    expect(readEnvValue(envPath, "FOO")).toBeUndefined();
  });
});

// ── upsertEnvLine ─────────────────────────────────────────────────────

describe("upsertEnvLine", () => {
  it("creates file when it doesn't exist", () => {
    upsertEnvLine(envPath, "NEW_KEY", "new_val");
    expect(fs.readFileSync(envPath, "utf-8")).toBe("NEW_KEY=new_val\n");
  });

  it("appends key when file exists but key absent", () => {
    fs.writeFileSync(envPath, "OTHER=123\n");
    upsertEnvLine(envPath, "NEW_KEY", "new_val");
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("OTHER=123");
    expect(content).toContain("NEW_KEY=new_val");
  });

  it("replaces existing key in-place", () => {
    fs.writeFileSync(envPath, "A=1\nFOO=old\nB=2\n");
    upsertEnvLine(envPath, "FOO", "new");
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("FOO=new");
    expect(content).not.toContain("FOO=old");
    expect(content).toContain("A=1");
    expect(content).toContain("B=2");
  });

  it("removes duplicates when replacing", () => {
    fs.writeFileSync(envPath, "FOO=first\nBAR=x\nFOO=second\n");
    upsertEnvLine(envPath, "FOO", "final");
    const content = fs.readFileSync(envPath, "utf-8");
    const matches = content.match(/FOO=/g);
    expect(matches).toHaveLength(1);
    expect(content).toContain("FOO=final");
  });

  it("is idempotent — calling twice doesn't create duplicates", () => {
    upsertEnvLine(envPath, "KEY", "val1");
    upsertEnvLine(envPath, "KEY", "val2");
    const content = fs.readFileSync(envPath, "utf-8");
    const matches = content.match(/KEY=/g);
    expect(matches).toHaveLength(1);
    expect(content).toContain("KEY=val2");
  });

  it("preserves comments and blank lines", () => {
    fs.writeFileSync(envPath, "# comment\nA=1\n\nB=2\n");
    upsertEnvLine(envPath, "C", "3");
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("# comment");
    expect(content).toContain("A=1");
    expect(content).toContain("B=2");
    expect(content).toContain("C=3");
  });

  it("file always ends with exactly one newline", () => {
    upsertEnvLine(envPath, "A", "1");
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
    expect(content.endsWith("\n\n")).toBe(false);
  });
});

// ── ensureEnvLine ─────────────────────────────────────────────────────

describe("ensureEnvLine", () => {
  it("creates file when it doesn't exist", () => {
    ensureEnvLine(envPath, "KEY", "val");
    expect(fs.readFileSync(envPath, "utf-8")).toBe("KEY=val\n");
  });

  it("appends key when file exists but key absent", () => {
    fs.writeFileSync(envPath, "OTHER=123\n");
    ensureEnvLine(envPath, "KEY", "val");
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("KEY=val");
  });

  it("no-op when key already exists (even with different value)", () => {
    fs.writeFileSync(envPath, "KEY=original\n");
    ensureEnvLine(envPath, "KEY", "different");
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("KEY=original");
    expect(content).not.toContain("KEY=different");
  });

  it("no-op preserves file untouched", () => {
    const original = "KEY=original\nOTHER=x\n";
    fs.writeFileSync(envPath, original);
    ensureEnvLine(envPath, "KEY", "different");
    expect(fs.readFileSync(envPath, "utf-8")).toBe(original);
  });
});

// ── findDuplicateKeys ─────────────────────────────────────────────────

describe("findDuplicateKeys", () => {
  it("returns empty for no file", () => {
    expect(findDuplicateKeys(envPath)).toEqual([]);
  });

  it("returns empty for clean file", () => {
    fs.writeFileSync(envPath, "A=1\nB=2\n");
    expect(findDuplicateKeys(envPath)).toEqual([]);
  });

  it("detects duplicate keys", () => {
    fs.writeFileSync(envPath, "A=1\nB=2\nA=3\n");
    expect(findDuplicateKeys(envPath)).toEqual(["A"]);
  });

  it("detects multiple different duplicates", () => {
    fs.writeFileSync(envPath, "A=1\nB=2\nA=3\nB=4\nC=5\n");
    const dupes = findDuplicateKeys(envPath);
    expect(dupes).toContain("A");
    expect(dupes).toContain("B");
    expect(dupes).not.toContain("C");
  });

  it("ignores comments", () => {
    fs.writeFileSync(envPath, "# A=1\nA=2\n");
    expect(findDuplicateKeys(envPath)).toEqual([]);
  });
});
