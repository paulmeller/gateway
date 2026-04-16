import { describe, it, expect, beforeAll } from "vitest";
import { encryptValue, decryptValue } from "../src/db/vault-crypto";

beforeAll(() => {
  // Use a fixed key for test determinism
  process.env.VAULT_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

describe("vault-crypto", () => {
  it("encrypts and decrypts a value round-trip", () => {
    const plaintext = "sk-ant-api03-abc123def456";
    const encrypted = encryptValue(plaintext);
    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptValue(encrypted)).toBe(plaintext);
  });

  it("each encryption produces different ciphertext (random IV)", () => {
    const plaintext = "same-secret";
    const a = encryptValue(plaintext);
    const b = encryptValue(plaintext);
    expect(a).not.toBe(b);
    expect(decryptValue(a)).toBe(plaintext);
    expect(decryptValue(b)).toBe(plaintext);
  });

  it("handles empty string", () => {
    const encrypted = encryptValue("");
    expect(decryptValue(encrypted)).toBe("");
  });

  it("handles unicode", () => {
    const plaintext = "héllo 🔒 wörld";
    const encrypted = encryptValue(plaintext);
    expect(decryptValue(encrypted)).toBe(plaintext);
  });

  it("handles very long values", () => {
    const plaintext = "x".repeat(10000);
    const encrypted = encryptValue(plaintext);
    expect(decryptValue(encrypted)).toBe(plaintext);
  });

  it("backwards-compat: returns plaintext unchanged if no enc: prefix", () => {
    // Pre-encryption values stored as plaintext
    expect(decryptValue("legacy-plaintext")).toBe("legacy-plaintext");
  });

  it("throws on tampered ciphertext (GCM auth tag mismatch)", () => {
    const encrypted = encryptValue("secret");
    const tampered = encrypted.slice(0, -4) + "AAAA";
    expect(() => decryptValue(tampered)).toThrow();
  });

});
