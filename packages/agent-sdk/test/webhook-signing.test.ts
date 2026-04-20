/**
 * v0.5 PR4a — webhook HMAC signing + verification.
 *
 * Covers:
 *   - round-trip: sign with one secret, verify succeeds
 *   - mismatched secret → fail
 *   - tampered body / signature / timestamp → fail
 *   - replay window enforcement
 *   - case-insensitive header lookup
 *   - outbound fireWebhook actually includes the headers when secret set
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-webhook-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
    __caDrizzle?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  delete g.__caActors;
}

describe("webhook signing helpers", () => {
  it("computeSignature + verifyWebhookSignature round-trip succeeds", async () => {
    const { computeSignature, verifyWebhookSignature } = await import("../src/webhooks/signing");
    const secret = "shared-secret-longer-than-32-characters";
    const body = JSON.stringify({ type: "session.status_idle", seq: 42 });
    const ts = 1_700_000_000_000;
    const sig = computeSignature(secret, ts, body);

    const res = verifyWebhookSignature({
      secret,
      body,
      nowMs: ts, // same instant
      headers: {
        "X-AgentStep-Signature": `sha256=${sig}`,
        "X-AgentStep-Timestamp": String(ts),
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.timestampMs).toBe(ts);
  });

  it("mismatched secret fails", async () => {
    const { computeSignature, verifyWebhookSignature } = await import("../src/webhooks/signing");
    const body = "{}";
    const ts = 1_700_000_000_000;
    const sig = computeSignature("right-secret-padded-to-32-chars-plus", ts, body);
    const res = verifyWebhookSignature({
      secret: "wrong-secret-padded-to-32-chars-plus",
      body,
      nowMs: ts,
      headers: {
        "X-AgentStep-Signature": `sha256=${sig}`,
        "X-AgentStep-Timestamp": String(ts),
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/mismatch/);
  });

  it("tampered body fails", async () => {
    const { computeSignature, verifyWebhookSignature } = await import("../src/webhooks/signing");
    const secret = "secret-secret-secret-secret-secret";
    const ts = 1_700_000_000_000;
    const sig = computeSignature(secret, ts, `{"a":1}`);
    const res = verifyWebhookSignature({
      secret, nowMs: ts,
      body: `{"a":2}`, // different
      headers: {
        "X-AgentStep-Signature": `sha256=${sig}`,
        "X-AgentStep-Timestamp": String(ts),
      },
    });
    expect(res.ok).toBe(false);
  });

  it("timestamp outside tolerance fails", async () => {
    const { computeSignature, verifyWebhookSignature } = await import("../src/webhooks/signing");
    const secret = "secret-secret-secret-secret-secret";
    const body = "{}";
    const ts = 1_000_000_000_000;
    const sig = computeSignature(secret, ts, body);
    const res = verifyWebhookSignature({
      secret, body,
      nowMs: ts + 10 * 60 * 1000, // 10 min after — outside default 5min
      headers: {
        "X-AgentStep-Signature": `sha256=${sig}`,
        "X-AgentStep-Timestamp": String(ts),
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/tolerance/);
  });

  it("accepts signature without sha256= prefix for forward-compat", async () => {
    const { computeSignature, verifyWebhookSignature } = await import("../src/webhooks/signing");
    const secret = "secret-secret-secret-secret-secret";
    const body = "{}";
    const ts = 1_700_000_000_000;
    const sig = computeSignature(secret, ts, body);
    const res = verifyWebhookSignature({
      secret, body, nowMs: ts,
      headers: {
        "X-AgentStep-Signature": sig, // no prefix
        "X-AgentStep-Timestamp": String(ts),
      },
    });
    expect(res.ok).toBe(true);
  });

  it("missing headers fail with a clear reason", async () => {
    const { verifyWebhookSignature } = await import("../src/webhooks/signing");
    const r1 = verifyWebhookSignature({
      secret: "secret-secret-secret-secret-secret", body: "{}",
      nowMs: 0, headers: {},
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/missing signature/);
  });

  it("case-insensitive header lookup", async () => {
    const { computeSignature, verifyWebhookSignature } = await import("../src/webhooks/signing");
    const secret = "secret-secret-secret-secret-secret";
    const body = "{}";
    const ts = 1_700_000_000_000;
    const sig = computeSignature(secret, ts, body);
    const res = verifyWebhookSignature({
      secret, body, nowMs: ts,
      headers: {
        "x-agentstep-signature": `sha256=${sig}`,
        "X-AGENTSTEP-TIMESTAMP": String(ts),
      },
    });
    expect(res.ok).toBe(true);
  });
});

describe("fireWebhook signs requests when a secret is configured", () => {
  beforeEach(() => freshDbEnv());

  it("sets X-AgentStep-Signature header on outbound POST", async () => {
    const { getDb } = await import("../src/db/client");
    const { createAgent } = await import("../src/db/agents");
    const { createEnvironment } = await import("../src/db/environments");
    const { createSession } = await import("../src/db/sessions");
    const { appendEvent } = await import("../src/sessions/bus");
    const { computeSignature } = await import("../src/webhooks/signing");
    const { seedDefaultTenant } = await import("../src/db/tenants");

    getDb();
    seedDefaultTenant();

    // Intercept fetch to capture the outbound request.
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      captured.push({ url: String(url), init: init ?? {} });
      return new Response("ok", { status: 200 });
    });

    try {
      const secret = "abcdefghijklmnopqrstuvwxyz-padding-padding";
      const agent = createAgent({
        name: "hook",
        model: "claude-sonnet-4-6",
        webhook_url: "https://example.test/hook",
        webhook_events: ["user.interrupt"],
        webhook_secret: secret,
      });
      const env = createEnvironment({
        name: "e",
        config: { type: "cloud", provider: "docker" },
      });
      // Sessions require env state=ready for turn-driver, but the bus
      // doesn't care — we're only testing event append → webhook send.
      getDb().prepare(`UPDATE environments SET state = 'ready' WHERE id = ?`).run(env.id);
      const session = createSession({
        agent_id: agent.id,
        agent_version: agent.version,
        environment_id: env.id,
      });

      appendEvent(session.id, {
        type: "user.interrupt",
        payload: {},
        origin: "user",
        processedAt: 1_700_000_000_000,
      });

      // fetch was called exactly once with signature + timestamp headers
      expect(captured).toHaveLength(1);
      const { init } = captured[0];
      const headers = new Headers(init.headers);
      const sig = headers.get("X-AgentStep-Signature");
      const ts  = headers.get("X-AgentStep-Timestamp");
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(ts).toMatch(/^\d+$/);

      // Sig is computed over `${ts}.${body}`.
      const body = typeof init.body === "string" ? init.body : "";
      const expected = `sha256=${computeSignature(secret, Number(ts), body)}`;
      expect(sig).toBe(expected);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("omits signature header when no secret is configured (back-compat)", async () => {
    const { getDb } = await import("../src/db/client");
    const { createAgent } = await import("../src/db/agents");
    const { createEnvironment } = await import("../src/db/environments");
    const { createSession } = await import("../src/db/sessions");
    const { appendEvent } = await import("../src/sessions/bus");
    const { seedDefaultTenant } = await import("../src/db/tenants");

    getDb();
    seedDefaultTenant();

    const captured: Array<{ init: RequestInit }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured.push({ init: init ?? {} });
      return new Response("ok", { status: 200 });
    });

    try {
      const agent = createAgent({
        name: "hook",
        model: "claude-sonnet-4-6",
        webhook_url: "https://example.test/hook",
        webhook_events: ["user.interrupt"],
        // no secret
      });
      const env = createEnvironment({ name: "e", config: { type: "cloud", provider: "docker" } });
      getDb().prepare(`UPDATE environments SET state = 'ready' WHERE id = ?`).run(env.id);
      const session = createSession({
        agent_id: agent.id,
        agent_version: agent.version,
        environment_id: env.id,
      });
      appendEvent(session.id, {
        type: "user.interrupt", payload: {}, origin: "user", processedAt: 1,
      });

      expect(captured).toHaveLength(1);
      const headers = new Headers(captured[0].init.headers);
      expect(headers.get("X-AgentStep-Signature")).toBeNull();
      expect(headers.get("X-AgentStep-Timestamp")).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
