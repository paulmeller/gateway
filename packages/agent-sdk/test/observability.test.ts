/**
 * End-to-end tests for the observability platform layer.
 *
 * Covers:
 *   1. GET /v1/traces/:id — span tree reassembly
 *   2. GET /v1/traces   — list of traces
 *   3. GET /v1/metrics  — on-read aggregation (totals, groups, stop_reasons,
 *                        tool latency percentiles)
 *   4. PII redaction hook — secrets in event payloads get scrubbed
 *   5. OTLP exporter     — trace → OTLP/JSON payload, auto-trigger on
 *                          root-turn-end, manual export handler
 *   6. Per-tool spans from the claude translator
 *   7. Sub-agent cost rollup into the parent session
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-obs-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.SPRITE_TOKEN = "test-token";
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake-for-test";
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTLP_ENDPOINT;
  delete process.env.OBS_REDACT_KEYS;
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

// Mirror api-comprehensive.test.ts: mock out lifecycle / provider registry
// so ensureInitialized doesn't try to contact a sprite backend during init.
vi.mock("../src/containers/lifecycle", () => ({
  acquireForFirstTurn: vi.fn(async () => "ca-sess-fake"),
  releaseSession: vi.fn(async () => {}),
  reconcileOrphans: vi.fn(async () => ({ deleted: 0, kept: 0 })),
  reconcileDockerOrphans: vi.fn(async () => ({ deleted: 0, kept: 0 })),
}));

/**
 * Boot the DB and seed a pinned API key. Returns the raw key string.
 * Every test that calls a handler must authenticate with this key.
 */
async function boot(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({
    name: "test",
    permissions: ["*"],
    rawKey: "test-api-key-obs",
  });
  return key;
}

function authReq(url: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${url}`, {
    ...init,
    headers: {
      "x-api-key": "test-api-key-obs",
      ...(init.headers ?? {}),
    },
  });
}

async function seedMinimalSchema(
  sessionId: string,
  extras: { agent_id?: string; backend?: string; created_at?: number } = {},
): Promise<void> {
  const { getDb } = await import("../src/db/client");
  const db = getDb();
  const agentId = extras.agent_id ?? "agent_o";
  const backend = extras.backend ?? "claude";
  const now = extras.created_at ?? 1_000_000;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, current_version, name, created_at, updated_at)
       VALUES (?, 1, 't', ?, ?)`,
    ).run(agentId, now, now);
    db.prepare(
      `INSERT OR IGNORE INTO agent_versions
         (agent_id, version, model, system, tools_json, mcp_servers_json, backend, created_at)
       VALUES (?, 1, 'claude-sonnet-4-6', NULL, '[]', '{}', ?, ?)`,
    ).run(agentId, backend, now);
    db.prepare(
      `INSERT OR IGNORE INTO environments (id, name, config_json, state, created_at)
       VALUES ('env_o', 't', '{}', 'ready', 0)`,
    ).run();
  } catch {
    /* already seeded */
  }
  db.prepare(
    `INSERT INTO sessions (
       id, agent_id, agent_version, environment_id, status,
       title, metadata_json, created_at, updated_at, sprite_name
     ) VALUES (?, ?, 1, 'env_o', 'idle', NULL, '{}', ?, ?, 'ca-sess-fake')`,
  ).run(sessionId, agentId, now, now);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Trace query handler
// ─────────────────────────────────────────────────────────────────────────

describe("handleGetTrace", () => {
  beforeEach(freshDbEnv);

  it("reassembles a span tree from a complete event log", async () => {
    await boot();
    const { appendEvent } = await import("../src/sessions/bus");
    const { handleGetTrace } = await import("../src/handlers/traces");
    await seedMinimalSchema("sess_t1");

    const traceId = "trace_fixture_1";
    const rootSpan = "span_root_1";
    const toolSpan = "span_tool_1";

    // turn_start
    appendEvent("sess_t1", {
      type: "span.model_request_start",
      payload: { model: "claude-sonnet-4-6" },
      origin: "server",
      traceId,
      spanId: rootSpan,
      parentSpanId: null,
    });
    // tool_call_start (child of root)
    appendEvent("sess_t1", {
      type: "span.tool_call_start",
      payload: { tool_use_id: "t1", name: "Bash", tool_class: "builtin" },
      origin: "server",
      traceId,
      spanId: toolSpan,
      parentSpanId: rootSpan,
    });
    // tool_call_end
    appendEvent("sess_t1", {
      type: "span.tool_call_end",
      payload: {
        tool_use_id: "t1",
        name: "Bash",
        status: "ok",
        duration_ms: 42,
      },
      origin: "server",
      traceId,
      spanId: toolSpan,
      parentSpanId: rootSpan,
    });
    // model_request_end
    appendEvent("sess_t1", {
      type: "span.model_request_end",
      payload: {
        model: "claude-sonnet-4-6",
        status: "ok",
        model_usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cost_usd: 0.003,
        },
      },
      origin: "server",
      traceId,
      spanId: rootSpan,
      parentSpanId: null,
    });

    const res = await handleGetTrace(
      authReq(`/v1/traces/${traceId}`),
      traceId,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trace_id: string;
      turn_count: number;
      tool_call_count: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      spans: Array<{
        name: string;
        status: string;
        children: Array<{ name: string; status: string }>;
      }>;
    };
    expect(body.trace_id).toBe(traceId);
    expect(body.turn_count).toBe(1);
    expect(body.tool_call_count).toBe(1);
    expect(body.input_tokens).toBe(100);
    expect(body.output_tokens).toBe(50);
    expect(body.cost_usd).toBeCloseTo(0.003, 5);

    // Tree: one root (turn), with one child (tool)
    expect(body.spans).toHaveLength(1);
    expect(body.spans[0].name).toContain("turn");
    expect(body.spans[0].status).toBe("ok");
    expect(body.spans[0].children).toHaveLength(1);
    expect(body.spans[0].children[0].name).toContain("Bash");
    expect(body.spans[0].children[0].status).toBe("ok");
  });

  it("handles unclosed spans gracefully", async () => {
    await boot();
    const { appendEvent } = await import("../src/sessions/bus");
    const { handleGetTrace } = await import("../src/handlers/traces");
    await seedMinimalSchema("sess_t2");

    const traceId = "trace_unclosed";
    appendEvent("sess_t2", {
      type: "span.model_request_start",
      payload: { model: "claude-sonnet-4-6" },
      origin: "server",
      traceId,
      spanId: "span_unclosed",
      parentSpanId: null,
    });
    // Extra sibling event so the trace has a deterministic "last ms"
    appendEvent("sess_t2", {
      type: "agent.message",
      payload: { content: [{ type: "text", text: "hi" }] },
      origin: "server",
      traceId,
      spanId: "span_unclosed",
      parentSpanId: null,
    });

    const res = await handleGetTrace(
      authReq(`/v1/traces/${traceId}`),
      traceId,
    );
    const body = (await res.json()) as {
      spans: Array<{ status: string; duration_ms: number | null }>;
    };
    expect(body.spans).toHaveLength(1);
    expect(body.spans[0].status).toBe("unclosed");
    expect(body.spans[0].duration_ms).not.toBeNull();
  });

  it("returns 404 for a non-existent trace", async () => {
    await boot();
    const { handleGetTrace } = await import("../src/handlers/traces");
    const res = await handleGetTrace(
      authReq("/v1/traces/trace_missing"),
      "trace_missing",
    );
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Metrics handler
// ─────────────────────────────────────────────────────────────────────────

describe("handleGetMetrics", () => {
  beforeEach(freshDbEnv);

  it("aggregates totals across sessions and returns stop-reason distribution", async () => {
    await boot();
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    await seedMinimalSchema("sess_m1");
    await seedMinimalSchema("sess_m2");

    // Patch sessions with usage + turn counts
    db.prepare(
      `UPDATE sessions SET
         turn_count = 2, tool_calls_count = 5,
         usage_input_tokens = 400, usage_output_tokens = 200, usage_cost_usd = 0.01
       WHERE id = ?`,
    ).run("sess_m1");
    db.prepare(
      `UPDATE sessions SET
         turn_count = 1, tool_calls_count = 1,
         usage_input_tokens = 100, usage_output_tokens = 50, usage_cost_usd = 0.002
       WHERE id = ?`,
    ).run("sess_m2");

    const { appendEvent } = await import("../src/sessions/bus");
    // status_idle events for stop-reason distribution
    appendEvent("sess_m1", {
      type: "session.status_idle",
      payload: { stop_reason: { type: "end_turn" } },
      origin: "server",
    });
    appendEvent("sess_m1", {
      type: "session.status_idle",
      payload: { stop_reason: { type: "end_turn" } },
      origin: "server",
    });
    appendEvent("sess_m2", {
      type: "session.status_idle",
      payload: { stop_reason: { type: "error" } },
      origin: "server",
    });
    // tool_call_end with duration for percentile check
    appendEvent("sess_m1", {
      type: "span.tool_call_end",
      payload: { status: "ok", duration_ms: 100 },
      origin: "server",
    });
    appendEvent("sess_m1", {
      type: "span.tool_call_end",
      payload: { status: "ok", duration_ms: 500 },
      origin: "server",
    });
    appendEvent("sess_m2", {
      type: "span.tool_call_end",
      payload: { status: "ok", duration_ms: 2000 },
      origin: "server",
    });

    const { handleGetMetrics } = await import("../src/handlers/metrics");
    const res = await handleGetMetrics(
      authReq("/v1/metrics?group_by=agent&from=0&to=9999999999999"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: {
        session_count: number;
        turn_count: number;
        tool_call_count: number;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
      };
      groups: Array<{ key: string; turn_count: number }>;
      stop_reasons: Record<string, number>;
      tool_latency_p50_ms: number | null;
      tool_latency_p95_ms: number | null;
    };
    expect(body.totals.session_count).toBe(2);
    expect(body.totals.turn_count).toBe(3);
    expect(body.totals.tool_call_count).toBe(6);
    expect(body.totals.input_tokens).toBe(500);
    expect(body.totals.output_tokens).toBe(250);
    expect(body.totals.cost_usd).toBeCloseTo(0.012, 5);

    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].turn_count).toBe(3);

    expect(body.stop_reasons.end_turn).toBe(2);
    expect(body.stop_reasons.error).toBe(1);

    // 3 samples sorted = [100, 500, 2000]. p50 = idx 1 = 500, p95 = idx 2 = 2000.
    expect(body.tool_latency_p50_ms).toBe(500);
    expect(body.tool_latency_p95_ms).toBe(2000);
  });

  it("respects agent_id filter", async () => {
    await boot();
    const { getDb } = await import("../src/db/client");
    await seedMinimalSchema("sess_f1", { agent_id: "agent_a" });
    await seedMinimalSchema("sess_f2", { agent_id: "agent_b" });
    const db = getDb();
    db.prepare(
      `UPDATE sessions SET turn_count = 10 WHERE id = 'sess_f1'`,
    ).run();
    db.prepare(
      `UPDATE sessions SET turn_count = 3 WHERE id = 'sess_f2'`,
    ).run();

    const { handleGetMetrics } = await import("../src/handlers/metrics");
    const res = await handleGetMetrics(
      authReq("/v1/metrics?from=0&to=9999999999999&agent_id=agent_a"),
    );
    const body = (await res.json()) as { totals: { turn_count: number; session_count: number } };
    expect(body.totals.turn_count).toBe(10);
    expect(body.totals.session_count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. PII redaction hook
// ─────────────────────────────────────────────────────────────────────────

describe("PII redaction hook", () => {
  beforeEach(freshDbEnv);

  it("scrubs known secrets from payloads before insert", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-supersecret-12345";
    const { installPayloadRedactor, appendEvent } = await import("../src/sessions/bus");
    const { redactAppendInput } = await import("../src/observability/redactor");
    installPayloadRedactor(redactAppendInput);

    await seedMinimalSchema("sess_r1");

    const row = appendEvent("sess_r1", {
      type: "agent.tool_result",
      payload: {
        content: [
          {
            type: "text",
            text: "leaking key sk-ant-supersecret-12345 in output",
          },
        ],
      },
      origin: "server",
    });

    expect(row.payload_json).not.toContain("sk-ant-supersecret-12345");
    expect(row.payload_json).toContain("[REDACTED]");
  });

  it("is a no-op when no secrets are configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.FACTORY_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.SPRITE_TOKEN;
    delete process.env.OBS_REDACT_KEYS;
    const { installPayloadRedactor, appendEvent } = await import("../src/sessions/bus");
    const { redactAppendInput, invalidateRedactorCache } = await import(
      "../src/observability/redactor"
    );
    invalidateRedactorCache();
    installPayloadRedactor(redactAppendInput);

    await seedMinimalSchema("sess_r2");

    const row = appendEvent("sess_r2", {
      type: "agent.message",
      payload: { content: [{ type: "text", text: "hello world" }] },
      origin: "server",
    });

    expect(row.payload_json).toContain("hello world");
    expect(row.payload_json).not.toContain("[REDACTED]");
  });

  it("scrubs values listed in OBS_REDACT_KEYS", async () => {
    process.env.MY_CUSTOM_SECRET = "hunter22";
    process.env.OBS_REDACT_KEYS = "MY_CUSTOM_SECRET";
    const { installPayloadRedactor, appendEvent } = await import("../src/sessions/bus");
    const { redactAppendInput, invalidateRedactorCache } = await import(
      "../src/observability/redactor"
    );
    invalidateRedactorCache();
    installPayloadRedactor(redactAppendInput);

    await seedMinimalSchema("sess_r3");
    const row = appendEvent("sess_r3", {
      type: "agent.message",
      payload: { content: [{ type: "text", text: "the password is hunter22 today" }] },
      origin: "server",
    });
    expect(row.payload_json).not.toContain("hunter22");
    expect(row.payload_json).toContain("[REDACTED]");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. OTLP exporter
// ─────────────────────────────────────────────────────────────────────────

describe("OTLP exporter", () => {
  beforeEach(freshDbEnv);

  it("converts a trace into a well-formed OTLP/JSON payload", async () => {
    const { appendEvent } = await import("../src/sessions/bus");
    const { buildOtlpPayload } = await import("../src/observability/otlp");
    const { listEventsByTrace } = await import("../src/db/events");
    await seedMinimalSchema("sess_o1");

    const traceId = "trace_otlp_1";
    const rootSpan = "span_otlp_root";
    appendEvent("sess_o1", {
      type: "span.model_request_start",
      payload: { model: "claude-sonnet-4-6" },
      origin: "server",
      traceId,
      spanId: rootSpan,
      parentSpanId: null,
    });
    appendEvent("sess_o1", {
      type: "span.model_request_end",
      payload: {
        model: "claude-sonnet-4-6",
        status: "ok",
        model_usage: {
          input_tokens: 77,
          output_tokens: 33,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cost_usd: 0.005,
        },
      },
      origin: "server",
      traceId,
      spanId: rootSpan,
      parentSpanId: null,
    });

    const events = listEventsByTrace(traceId);
    const payload = buildOtlpPayload(events, traceId);
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(1);
    const s = spans[0];
    expect(s.name).toContain("turn");
    expect(s.traceId).toHaveLength(32); // 16 bytes hex
    expect(s.spanId).toHaveLength(16); // 8 bytes hex
    expect(s.status.code).toBe(1); // OK

    // gen_ai.* attributes present
    const attrs = Object.fromEntries(
      s.attributes.map((kv) => [
        kv.key,
        "stringValue" in kv.value
          ? kv.value.stringValue
          : "intValue" in kv.value
            ? Number(kv.value.intValue)
            : "doubleValue" in kv.value
              ? kv.value.doubleValue
              : null,
      ]),
    );
    expect(attrs["gen_ai.system"]).toBe("anthropic");
    expect(attrs["gen_ai.operation.name"]).toBe("chat");
    expect(attrs["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(77);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(33);
    expect(attrs["agentstep.cost_usd"]).toBeCloseTo(0.005, 5);
  });

  it("POSTs to the configured OTLP endpoint when exportTrace is called", async () => {
    // Stand up a tiny in-process capture for fetch
    const fetchCalls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
    const origFetch = globalThis.fetch;
    // @ts-expect-error override
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({
        url: String(url),
        body,
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      process.env.OTLP_ENDPOINT = "http://otlp.example/v1/traces";
      process.env.OTLP_AUTHORIZATION = "Bearer test-token";
      const { appendEvent } = await import("../src/sessions/bus");
      await seedMinimalSchema("sess_o2");
      const traceId = "trace_otlp_2";
      appendEvent("sess_o2", {
        type: "span.model_request_start",
        payload: { model: "claude-sonnet-4-6" },
        origin: "server",
        traceId,
        spanId: "span_o2",
        parentSpanId: null,
      });
      appendEvent("sess_o2", {
        type: "span.model_request_end",
        payload: { model: "claude-sonnet-4-6", status: "ok", model_usage: null },
        origin: "server",
        traceId,
        spanId: "span_o2",
        parentSpanId: null,
      });

      // Invalidate config cache so the new env var is picked up
      const { invalidateConfigCache } = await import("../src/config");
      invalidateConfigCache();

      const { exportTrace } = await import("../src/observability/otlp");
      const result = await exportTrace(traceId);
      expect(result.ok).toBe(true);
      expect(result.spanCount).toBe(1);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe("http://otlp.example/v1/traces");
      expect(fetchCalls[0].headers.Authorization).toBe("Bearer test-token");
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.OTLP_ENDPOINT;
      delete process.env.OTLP_AUTHORIZATION;
    }
  });

  it("returns no-endpoint error when OTLP_ENDPOINT is unset", async () => {
    const { invalidateConfigCache } = await import("../src/config");
    invalidateConfigCache();
    const { exportTrace } = await import("../src/observability/otlp");
    const result = await exportTrace("trace_noop");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no OTLP endpoint");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Sub-agent cost rollup (architect's #1 omission)
// ─────────────────────────────────────────────────────────────────────────

describe("sub-agent cost rollup", () => {
  beforeEach(freshDbEnv);

  it("rolls up child session usage into the parent when a thread completes", async () => {
    // We exercise the rollup logic without running a full thread. The
    // driver's `handleSpawnAgent` path reads `getSessionRow(child)` after
    // the child has run and `bumpSessionStats(parent, {...})`s the usage
    // onto the parent. Simulate that final read+bump step here.
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    await seedMinimalSchema("sess_parent");
    await seedMinimalSchema("sess_child");

    // Mark the child as a thread of the parent and give it usage totals.
    db.prepare(
      `UPDATE sessions SET
         parent_session_id = 'sess_parent',
         thread_depth = 1,
         turn_count = 1,
         tool_calls_count = 4,
         usage_input_tokens = 1000,
         usage_output_tokens = 500,
         usage_cache_read_input_tokens = 100,
         usage_cache_creation_input_tokens = 50,
         usage_cost_usd = 0.025
       WHERE id = 'sess_child'`,
    ).run();

    // Give the parent some pre-existing usage so we can verify the deltas
    // ADD rather than replace.
    db.prepare(
      `UPDATE sessions SET
         turn_count = 2,
         tool_calls_count = 1,
         usage_input_tokens = 200,
         usage_output_tokens = 100,
         usage_cost_usd = 0.005
       WHERE id = 'sess_parent'`,
    ).run();

    // Manually invoke the rollup path. This mirrors the final block of
    // `handleSpawnAgent` in sessions/threads.ts.
    const { getSessionRow, bumpSessionStats } = await import("../src/db/sessions");
    const child = getSessionRow("sess_child")!;
    bumpSessionStats(
      "sess_parent",
      { tool_calls_count: child.tool_calls_count },
      {
        input_tokens: child.usage_input_tokens,
        output_tokens: child.usage_output_tokens,
        cache_read_input_tokens: child.usage_cache_read_input_tokens,
        cache_creation_input_tokens: child.usage_cache_creation_input_tokens,
        cost_usd: child.usage_cost_usd,
      },
    );

    const parent = getSessionRow("sess_parent")!;
    // Parent turn_count must NOT change — child turns stay separate
    expect(parent.turn_count).toBe(2);
    // Tool calls roll up
    expect(parent.tool_calls_count).toBe(1 + 4);
    // Usage deltas accumulate
    expect(parent.usage_input_tokens).toBe(200 + 1000);
    expect(parent.usage_output_tokens).toBe(100 + 500);
    expect(parent.usage_cache_read_input_tokens).toBe(100);
    expect(parent.usage_cache_creation_input_tokens).toBe(50);
    expect(parent.usage_cost_usd).toBeCloseTo(0.005 + 0.025, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Claude translator per-tool span plumbing
// ─────────────────────────────────────────────────────────────────────────

describe("claude translator per-tool spans", () => {
  it("emits span.tool_call_start/end around a builtin tool when turnSpanId is set", async () => {
    const { createClaudeTranslator } = await import(
      "../src/backends/claude/translator"
    );
    const t = createClaudeTranslator({
      customToolNames: new Set(),
      isFirstTurn: true,
      turnSpanId: "span_turn_root",
    });

    const events = [
      ...t.translate({
        type: "system",
        subtype: "init",
        session_id: "cc_1",
      }),
      ...t.translate({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "Bash",
              input: { cmd: "ls" },
            },
          ],
        },
      }),
      ...t.translate({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: "ok",
            },
          ],
        },
      }),
    ];

    const types = events.map((e) => e.type);
    expect(types).toContain("span.tool_call_start");
    expect(types).toContain("agent.tool_use");
    expect(types).toContain("agent.tool_result");
    expect(types).toContain("span.tool_call_end");

    const startSpan = events.find((e) => e.type === "span.tool_call_start")!;
    const endSpan = events.find((e) => e.type === "span.tool_call_end")!;
    expect(startSpan.spanId).toBeDefined();
    expect(startSpan.parentSpanId).toBe("span_turn_root");
    expect(endSpan.spanId).toBe(startSpan.spanId);

    // The agent.tool_use + agent.tool_result rows should also ride on the
    // tool span id so they nest inside it in the waterfall.
    const toolUse = events.find((e) => e.type === "agent.tool_use")!;
    const toolResult = events.find((e) => e.type === "agent.tool_result")!;
    expect(toolUse.spanId).toBe(startSpan.spanId);
    expect(toolResult.spanId).toBe(startSpan.spanId);
  });

  it("does NOT emit per-tool spans when turnSpanId is omitted (back-compat)", async () => {
    const { createClaudeTranslator } = await import(
      "../src/backends/claude/translator"
    );
    const t = createClaudeTranslator({
      customToolNames: new Set(),
      isFirstTurn: true,
    });
    const events = [
      ...t.translate({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_02", name: "Bash", input: {} }],
        },
      }),
    ];
    expect(events.find((e) => e.type === "span.tool_call_start")).toBeUndefined();
    const toolUse = events.find((e) => e.type === "agent.tool_use")!;
    expect(toolUse.spanId).toBeUndefined();
  });
});
