/**
 * Unit + integration tests for the in-process API metrics recorder.
 *
 * Covers:
 *   1. Route normalization — ULID ids, prefixed ids, numeric ids, hex
 *      ids all collapse to `:id` so the route key space stays bounded.
 *   2. Recording + snapshot — counts, percentiles, status-class rollup,
 *      per-route aggregation.
 *   3. routeWrap auto-records — every request through the standard
 *      middleware shows up in the snapshot.
 *   4. `/v1/metrics/api` handler — happy path + window_minutes param.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-api-metrics-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.SPRITE_TOKEN = "test-token";
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-test";
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caBusAfterCommit?: unknown;
    __caBusRedactor?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caActors?: unknown;
    __caSweeperHandle?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caBusAfterCommit;
  delete g.__caBusRedactor;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  delete g.__caActors;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
}

vi.mock("../src/containers/lifecycle", () => ({
  acquireForFirstTurn: vi.fn(async () => "ca-sess-fake"),
  releaseSession: vi.fn(async () => {}),
  reconcileOrphans: vi.fn(async () => ({ deleted: 0, kept: 0 })),
  reconcileDockerOrphans: vi.fn(async () => ({ deleted: 0, kept: 0 })),
}));

// ─────────────────────────────────────────────────────────────────────────
// 1. Route normalization
// ─────────────────────────────────────────────────────────────────────────

describe("normalizeRoute", () => {
  it("collapses prefixed ULIDs into :id", async () => {
    const { normalizeRoute } = await import("../src/observability/api-metrics");
    expect(normalizeRoute("/v1/sessions/sess_01HXXXXXXXXXXXXXXXXXXXXXXX")).toBe(
      "/v1/sessions/:id",
    );
    expect(
      normalizeRoute("/v1/sessions/sess_01HXXXXXXXXXXXXXXXXXXXXXXX/events"),
    ).toBe("/v1/sessions/:id/events");
    expect(normalizeRoute("/v1/agents/agent_01HYYYYYYYYYYYYYYYYYYYYYYY")).toBe(
      "/v1/agents/:id",
    );
  });

  it("collapses bare ULIDs", async () => {
    const { normalizeRoute } = await import("../src/observability/api-metrics");
    expect(normalizeRoute("/v1/traces/01HXXXXXXXXXXXXXXXXXXXXXXX")).toBe(
      "/v1/traces/:id",
    );
  });

  it("collapses numeric segments and strips query strings", async () => {
    const { normalizeRoute } = await import("../src/observability/api-metrics");
    expect(normalizeRoute("/v1/batch/42?foo=bar")).toBe("/v1/batch/:id");
  });

  it("leaves short static segments alone", async () => {
    const { normalizeRoute } = await import("../src/observability/api-metrics");
    expect(normalizeRoute("/v1/metrics/api")).toBe("/v1/metrics/api");
    expect(normalizeRoute("/v1/agents")).toBe("/v1/agents");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Recording + snapshot
// ─────────────────────────────────────────────────────────────────────────

describe("recordApiRequest + snapshotApiMetrics", () => {
  it("aggregates counts, percentiles, and status classes per route", async () => {
    const { recordApiRequest, snapshotApiMetrics, resetApiMetrics } = await import(
      "../src/observability/api-metrics"
    );
    resetApiMetrics();

    // Three 200s on /v1/agents with increasing latencies
    recordApiRequest("/v1/agents", 10, 200);
    recordApiRequest("/v1/agents", 50, 200);
    recordApiRequest("/v1/agents", 500, 200);
    // One 404 on /v1/agents/:id
    recordApiRequest("/v1/agents/:id", 5, 404);
    // One 500 on /v1/sessions
    recordApiRequest("/v1/sessions", 800, 500);

    const snap = snapshotApiMetrics();
    expect(snap.totals.count).toBe(5);
    expect(snap.totals.status_2xx).toBe(3);
    expect(snap.totals.status_4xx).toBe(1);
    expect(snap.totals.status_5xx).toBe(1);
    // error_rate is 5xx-only — 4xx is client behavior, not server health
    expect(snap.totals.error_rate).toBeCloseTo(1 / 5, 5);

    // Per-route breakdown
    const agents = snap.routes.find((r) => r.route === "/v1/agents")!;
    expect(agents).toBeDefined();
    expect(agents.count).toBe(3);
    expect(agents.status_2xx).toBe(3);
    expect(agents.mean_ms).toBeCloseTo((10 + 50 + 500) / 3, 5);
    // With 3 samples sorted = [10, 50, 500]. p50 idx = floor(0.5 * 3) = 1 → 50
    expect(agents.p50_ms).toBe(50);

    const agentsId = snap.routes.find((r) => r.route === "/v1/agents/:id")!;
    expect(agentsId.count).toBe(1);
    expect(agentsId.status_4xx).toBe(1);
    // 404 alone is not an error — error_rate stays 0, status_4xx surfaces separately
    expect(agentsId.error_rate).toBe(0);

    const sessions = snap.routes.find((r) => r.route === "/v1/sessions")!;
    expect(sessions.status_5xx).toBe(1);
    expect(sessions.error_rate).toBe(1);

    // Timeline: should have MAX_MINUTES entries, all zero except the
    // current one which has the 5 recorded requests
    const nonEmpty = snap.timeline.filter((t) => t.count > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(1);
    expect(nonEmpty.reduce((acc, t) => acc + t.count, 0)).toBe(5);
  });

  it("resetApiMetrics clears the store", async () => {
    const { recordApiRequest, snapshotApiMetrics, resetApiMetrics } = await import(
      "../src/observability/api-metrics"
    );
    recordApiRequest("/v1/foo", 10, 200);
    resetApiMetrics();
    const snap = snapshotApiMetrics();
    expect(snap.totals.count).toBe(0);
    expect(snap.routes).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. routeWrap auto-records
// ─────────────────────────────────────────────────────────────────────────

describe("routeWrap records every request", () => {
  beforeEach(freshDbEnv);

  it("records the request even when the handler 404s", async () => {
    const { resetApiMetrics, snapshotApiMetrics } = await import(
      "../src/observability/api-metrics"
    );
    resetApiMetrics();

    const { getDb } = await import("../src/db/client");
    getDb();
    const { createApiKey } = await import("../src/db/api_keys");
    createApiKey({ name: "t", permissions: ["*"], rawKey: "test-api-key-apim" });

    const { handleGetTrace } = await import("../src/handlers/traces");
    // Use a ULID-shaped id so normalizeRoute collapses it to :id
    const missingId = "trace_01HXXXXXXXXXXXXXXXXXXXXXXX";
    const res = await handleGetTrace(
      new Request(`http://x/v1/traces/${missingId}`, {
        headers: { "x-api-key": "test-api-key-apim" },
      }),
      missingId,
    );
    expect(res.status).toBe(404);

    const snap = snapshotApiMetrics();
    // The recorder should show one 4xx against /v1/traces/:id (normalized)
    const entry = snap.routes.find((r) => r.route === "/v1/traces/:id");
    expect(entry).toBeDefined();
    expect(entry!.count).toBe(1);
    expect(entry!.status_4xx).toBe(1);
  });

  it("records latency accurately and counts 2xx correctly", async () => {
    const { resetApiMetrics, snapshotApiMetrics } = await import(
      "../src/observability/api-metrics"
    );
    resetApiMetrics();

    const { getDb } = await import("../src/db/client");
    getDb();
    const { createApiKey } = await import("../src/db/api_keys");
    createApiKey({ name: "t", permissions: ["*"], rawKey: "test-api-key-apim2" });

    // Hit /v1/metrics twice — it always returns 200
    const { handleGetMetrics } = await import("../src/handlers/metrics");
    for (let i = 0; i < 2; i++) {
      const res = await handleGetMetrics(
        new Request("http://x/v1/metrics?from=0&to=9999999999999", {
          headers: { "x-api-key": "test-api-key-apim2" },
        }),
      );
      expect(res.status).toBe(200);
    }

    const snap = snapshotApiMetrics();
    const entry = snap.routes.find((r) => r.route === "/v1/metrics");
    expect(entry).toBeDefined();
    expect(entry!.count).toBe(2);
    expect(entry!.status_2xx).toBe(2);
    expect(entry!.error_rate).toBe(0);
    // Latency samples should both be finite non-negative numbers
    expect(entry!.mean_ms).not.toBeNull();
    expect(entry!.mean_ms!).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. /v1/metrics/api handler
// ─────────────────────────────────────────────────────────────────────────

describe("handleGetApiMetrics", () => {
  beforeEach(freshDbEnv);

  it("returns the snapshot JSON with totals + routes + timeline", async () => {
    const { resetApiMetrics, recordApiRequest } = await import(
      "../src/observability/api-metrics"
    );
    resetApiMetrics();

    const { getDb } = await import("../src/db/client");
    getDb();
    const { createApiKey } = await import("../src/db/api_keys");
    createApiKey({ name: "t", permissions: ["*"], rawKey: "test-api-key-apim3" });

    recordApiRequest("/v1/agents", 25, 200);
    recordApiRequest("/v1/agents", 80, 200);

    const { handleGetApiMetrics } = await import("../src/handlers/metrics");
    const res = await handleGetApiMetrics(
      new Request("http://x/v1/metrics/api?window_minutes=60", {
        headers: { "x-api-key": "test-api-key-apim3" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window_minutes: number;
      totals: { count: number };
      routes: Array<{ route: string; count: number }>;
      timeline: Array<{ minute_ms: number; count: number }>;
    };
    expect(body.window_minutes).toBe(60);
    // +1 for the self-request we just made
    expect(body.totals.count).toBeGreaterThanOrEqual(2);
    expect(body.routes.find((r) => r.route === "/v1/agents")?.count).toBe(2);
    expect(body.timeline.length).toBeGreaterThan(0);
  });

  it("rejects invalid window_minutes", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    const { createApiKey } = await import("../src/db/api_keys");
    createApiKey({ name: "t", permissions: ["*"], rawKey: "test-api-key-apim4" });

    const { handleGetApiMetrics } = await import("../src/handlers/metrics");
    const res = await handleGetApiMetrics(
      new Request("http://x/v1/metrics/api?window_minutes=-5", {
        headers: { "x-api-key": "test-api-key-apim4" },
      }),
    );
    expect(res.status).toBe(400);
  });
});
