/**
 * Tests for query-parameter API key authentication.
 *
 * Browser-initiated downloads (window.open, <a> tags) can't set headers.
 * The auth middleware must accept the API key as a ?x-api-key query param
 * for these cases.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { extractKey } from "../src/auth/middleware";

describe("extractKey query-param fallback", () => {
  it("extracts key from x-api-key header (preferred)", () => {
    const req = new Request("http://localhost/anthropic/v1/files/abc/content", {
      headers: { "x-api-key": "ck_test123" },
    });
    expect(extractKey(req)).toBe("ck_test123");
  });

  it("extracts key from Authorization Bearer header", () => {
    const req = new Request("http://localhost/anthropic/v1/files/abc/content", {
      headers: { Authorization: "Bearer ck_test456" },
    });
    expect(extractKey(req)).toBe("ck_test456");
  });

  it("extracts key from ?x-api-key query parameter when no header present", () => {
    const req = new Request("http://localhost/anthropic/v1/files/abc/content?x-api-key=ck_test789");
    expect(extractKey(req)).toBe("ck_test789");
  });

  it("prefers header over query param", () => {
    const req = new Request("http://localhost/anthropic/v1/files/abc/content?x-api-key=ck_query", {
      headers: { "x-api-key": "ck_header" },
    });
    expect(extractKey(req)).toBe("ck_header");
  });

  it("rejects Anthropic passthrough keys in query params (security)", () => {
    const req = new Request(
      "http://localhost/anthropic/v1/files/abc/content?x-api-key=sk-ant-api03-xxxxxxxxxxxx",
    );
    expect(extractKey(req)).toBeNull();
  });

  it("allows Anthropic passthrough keys in headers (normal flow)", () => {
    const req = new Request("http://localhost/anthropic/v1/files/abc/content", {
      headers: { "x-api-key": "sk-ant-api03-xxxxxxxxxxxx" },
    });
    expect(extractKey(req)).toBe("sk-ant-api03-xxxxxxxxxxxx");
  });

  it("returns null when no auth provided at all", () => {
    const req = new Request("http://localhost/anthropic/v1/files/abc/content");
    expect(extractKey(req)).toBeNull();
  });

  it("handles URL-encoded query param values", () => {
    const key = "ck_test+special/chars=";
    const req = new Request(
      `http://localhost/anthropic/v1/files/abc/content?x-api-key=${encodeURIComponent(key)}`,
    );
    expect(extractKey(req)).toBe(key);
  });
});
