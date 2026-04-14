/**
 * OTLP/HTTP-JSON trace exporter.
 *
 * Minimal, dependency-free exporter that converts the gateway's event
 * log into an OpenTelemetry Trace Service payload and POSTs it to any
 * endpoint speaking OTLP/HTTP+JSON — Tempo, Honeycomb, Langfuse, Phoenix,
 * Jaeger, etc. Config via `OTEL_EXPORTER_OTLP_ENDPOINT` (or the settings
 * table via `otlp_endpoint`), mirroring the standard OTel env contract.
 *
 * ## Semantic conventions
 *
 * Attributes on model-request spans follow OpenTelemetry's GenAI spec
 * (`gen_ai.*`) so dashboards that know OTel work out of the box:
 *
 *   - `gen_ai.system`                — "anthropic" / "openai" / ...
 *   - `gen_ai.request.model`         — the model id
 *   - `gen_ai.operation.name`        — "chat" for turn spans, "tool" for tool spans
 *   - `gen_ai.usage.input_tokens`    — prompt tokens
 *   - `gen_ai.usage.output_tokens`   — completion tokens
 *   - `agentstep.*`                  — gateway-specific (session id, stop_reason, ...)
 *
 * ## Span assembly
 *
 * Takes a full trace (via `listEventsByTrace`) and walks the event log
 * pairing `span.*_start` with `span.*_end`. Unpaired starts are synthesized
 * as status=error with end_time = received_at of the last event in the
 * trace — defensive against the (now-fixed) span-leak paths.
 *
 * ## Trigger
 *
 * Installed as a post-commit hook on the bus. Fires on any event whose
 * type is `span.model_request_end` with `parent_span_id IS NULL` AND
 * whose session has no parent session (i.e., the root turn of the
 * topmost session). This ensures all sub-agent child spans have been
 * written before export.
 */
import { listEventsByTrace } from "../db/events";
import { getSessionRow } from "../db/sessions";
import { getAgent } from "../db/agents";
import { getConfig } from "../config";
import { onAfterCommit } from "../sessions/bus";
import type { EventRow } from "../types";

// ─────────────────────────────────────────────────────────────────────────
// OTLP/HTTP JSON types (trimmed to what we emit)
// ─────────────────────────────────────────────────────────────────────────

interface KeyValue {
  key: string;
  value: AnyValue;
}

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

const STATUS_CODE_UNSET = 0;
const STATUS_CODE_OK = 1;
const STATUS_CODE_ERROR = 2;

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  status: { code: number; message?: string };
}

interface OtlpPayload {
  resourceSpans: Array<{
    resource: { attributes: KeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version?: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────
// ID conversion
//
// OTLP wants hex-encoded bytes: 16-byte (32 hex char) trace id and 8-byte
// (16 hex char) span id. We have ULID-based ids like `trace_01HXXXX`.
// Use a deterministic SHA-256 truncation so the same gateway id always
// maps to the same OTel id — round-trips when debugging.
// ─────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

function toHex(input: string, bytes: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, bytes * 2);
}

function traceIdHex(traceId: string): string {
  return toHex(traceId, 16);
}

function spanIdHex(spanId: string): string {
  return toHex(spanId, 8);
}

// ─────────────────────────────────────────────────────────────────────────
// Attribute helpers
// ─────────────────────────────────────────────────────────────────────────

function strAttr(key: string, value: string | null | undefined): KeyValue | null {
  if (value == null) return null;
  return { key, value: { stringValue: value } };
}

function intAttr(key: string, value: number | null | undefined): KeyValue | null {
  if (value == null) return null;
  return { key, value: { intValue: String(Math.round(value)) } };
}

function numAttr(key: string, value: number | null | undefined): KeyValue | null {
  if (value == null) return null;
  return { key, value: { doubleValue: value } };
}

function boolAttr(key: string, value: boolean | null | undefined): KeyValue | null {
  if (value == null) return null;
  return { key, value: { boolValue: value } };
}

function compact(kvs: Array<KeyValue | null>): KeyValue[] {
  return kvs.filter((k): k is KeyValue => k != null);
}

function msToNano(ms: number): string {
  // OTLP wants nanoseconds as a decimal string.
  return `${BigInt(ms) * 1_000_000n}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Trace → OTLP payload
// ─────────────────────────────────────────────────────────────────────────

type ParsedPayload = Record<string, unknown>;

function parsePayload(row: EventRow): ParsedPayload {
  try {
    return JSON.parse(row.payload_json) as ParsedPayload;
  } catch {
    return {};
  }
}

/**
 * Pair `span.*_start` / `span.*_end` events into OTLP spans.
 *
 * We walk the events in insertion order (the caller already does the
 * cross-session merge sort) and track open spans by `span_id`. For
 * events that don't have matching start/end we still try to produce a
 * span by using received_at as both times — better to emit a zero-width
 * span than lose the work entirely.
 */
interface OpenSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startMs: number;
  attributes: KeyValue[];
}

function backendSystem(row: EventRow): string {
  // Gateway doesn't annotate `gen_ai.system` directly on events; infer
  // from session.agent.engine at export time if we can look it up.
  // Fall back to `agentstep` so the attribute is always present.
  try {
    const sess = getSessionRow(row.session_id);
    if (!sess) return "agentstep";
    const agent = getAgent(sess.agent_id, sess.agent_version);
    if (!agent) return "agentstep";
    switch (agent.engine) {
      case "claude":
      case "anthropic":
        return "anthropic";
      case "codex":
        return "openai";
      case "gemini":
        return "gemini";
      case "factory":
        return "factory";
      case "opencode":
        return "opencode";
      default:
        return agent.engine;
    }
  } catch {
    return "agentstep";
  }
}

/**
 * Build an OTLP `spans` array from a complete trace event log.
 */
export function traceToOtlpSpans(events: EventRow[], traceId: string): OtlpSpan[] {
  const spans: OtlpSpan[] = [];
  const open = new Map<string, OpenSpan>();

  // Track the parent session id so we emit a sensible name for each span
  // and can annotate per-turn attributes even on the leg we infer.
  let defaultSystem = "agentstep";
  if (events.length > 0) {
    defaultSystem = backendSystem(events[0]);
  }

  for (const e of events) {
    if (!e.span_id) continue;

    const payload = parsePayload(e);

    if (e.type === "span.model_request_start") {
      const model = typeof payload.model === "string" ? payload.model : null;
      open.set(e.span_id, {
        spanId: e.span_id,
        parentSpanId: e.parent_span_id ?? null,
        name: model ? `turn ${model}` : "turn",
        startMs: e.received_at,
        attributes: compact([
          strAttr("gen_ai.system", defaultSystem),
          strAttr("gen_ai.operation.name", "chat"),
          strAttr("gen_ai.request.model", model),
          strAttr("agentstep.session_id", e.session_id),
          strAttr("agentstep.event.type", e.type),
        ]),
      });
      continue;
    }

    if (e.type === "span.model_request_end") {
      const openSpan = open.get(e.span_id);
      if (!openSpan) {
        // Dangling end — skip.
        continue;
      }
      open.delete(e.span_id);

      const usage = (payload.model_usage ?? null) as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            cost_usd?: number;
          }
        | null;
      const status = typeof payload.status === "string" ? payload.status : "ok";
      const statusCode = status === "ok" ? STATUS_CODE_OK : STATUS_CODE_ERROR;

      spans.push({
        traceId: traceIdHex(traceId),
        spanId: spanIdHex(e.span_id),
        parentSpanId: openSpan.parentSpanId ? spanIdHex(openSpan.parentSpanId) : undefined,
        name: openSpan.name,
        kind: 1, // INTERNAL
        startTimeUnixNano: msToNano(openSpan.startMs),
        endTimeUnixNano: msToNano(e.received_at),
        attributes: compact([
          ...openSpan.attributes,
          intAttr("gen_ai.usage.input_tokens", usage?.input_tokens),
          intAttr("gen_ai.usage.output_tokens", usage?.output_tokens),
          intAttr("gen_ai.usage.cache_read_input_tokens", usage?.cache_read_input_tokens),
          intAttr("gen_ai.usage.cache_creation_input_tokens", usage?.cache_creation_input_tokens),
          numAttr("agentstep.cost_usd", usage?.cost_usd),
          strAttr("agentstep.span.status", status),
        ]),
        status: {
          code: statusCode,
          message: statusCode === STATUS_CODE_ERROR ? status : undefined,
        },
      });
      continue;
    }

    if (e.type === "span.tool_call_start") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const toolClass = typeof payload.tool_class === "string" ? payload.tool_class : null;
      open.set(e.span_id, {
        spanId: e.span_id,
        parentSpanId: e.parent_span_id ?? null,
        name: `tool ${name}`,
        startMs: e.received_at,
        attributes: compact([
          strAttr("gen_ai.system", defaultSystem),
          strAttr("gen_ai.operation.name", "tool"),
          strAttr("agentstep.tool.name", name),
          strAttr("agentstep.tool.class", toolClass),
          strAttr("agentstep.session_id", e.session_id),
          strAttr(
            "agentstep.tool.tool_use_id",
            typeof payload.tool_use_id === "string" ? payload.tool_use_id : null,
          ),
        ]),
      });
      continue;
    }

    if (e.type === "span.tool_call_end") {
      const openSpan = open.get(e.span_id);
      if (!openSpan) continue;
      open.delete(e.span_id);

      const status = typeof payload.status === "string" ? payload.status : "ok";
      const statusCode = status === "ok" ? STATUS_CODE_OK : STATUS_CODE_ERROR;
      const durationMs = typeof payload.duration_ms === "number" ? payload.duration_ms : null;

      spans.push({
        traceId: traceIdHex(traceId),
        spanId: spanIdHex(e.span_id),
        parentSpanId: openSpan.parentSpanId ? spanIdHex(openSpan.parentSpanId) : undefined,
        name: openSpan.name,
        kind: 1,
        startTimeUnixNano: msToNano(openSpan.startMs),
        endTimeUnixNano: msToNano(e.received_at),
        attributes: compact([
          ...openSpan.attributes,
          numAttr("agentstep.tool.duration_ms", durationMs),
          boolAttr(
            "agentstep.tool.is_error",
            typeof payload.is_error === "boolean" ? payload.is_error : status !== "ok",
          ),
        ]),
        status: {
          code: statusCode,
          message: statusCode === STATUS_CODE_ERROR ? status : undefined,
        },
      });
      continue;
    }

    if (e.type === "span.outcome_evaluation_start" || e.type === "span.outcome_evaluation_end") {
      // Grader spans — treat like a nested span pair under the turn.
      if (e.type === "span.outcome_evaluation_start") {
        open.set(e.span_id, {
          spanId: e.span_id,
          parentSpanId: e.parent_span_id ?? null,
          name: "outcome_evaluation",
          startMs: e.received_at,
          attributes: compact([
            strAttr("gen_ai.system", defaultSystem),
            strAttr("gen_ai.operation.name", "grader"),
            strAttr("agentstep.session_id", e.session_id),
            intAttr("agentstep.grader.iteration", typeof payload.iteration === "number" ? payload.iteration : null),
          ]),
        });
      } else {
        const openSpan = open.get(e.span_id);
        if (!openSpan) continue;
        open.delete(e.span_id);
        spans.push({
          traceId: traceIdHex(traceId),
          spanId: spanIdHex(e.span_id),
          parentSpanId: openSpan.parentSpanId ? spanIdHex(openSpan.parentSpanId) : undefined,
          name: openSpan.name,
          kind: 1,
          startTimeUnixNano: msToNano(openSpan.startMs),
          endTimeUnixNano: msToNano(e.received_at),
          attributes: compact([
            ...openSpan.attributes,
            strAttr("agentstep.grader.result", typeof payload.result === "string" ? payload.result : null),
          ]),
          status: { code: STATUS_CODE_OK },
        });
      }
      continue;
    }
  }

  // Any still-open spans at this point are genuinely leaked — the turn
  // never emitted a matching end. Close them at the trace's last event
  // time with an error status so users at least see the open work.
  if (open.size > 0) {
    const lastMs = events[events.length - 1]?.received_at ?? Date.now();
    for (const openSpan of open.values()) {
      spans.push({
        traceId: traceIdHex(traceId),
        spanId: spanIdHex(openSpan.spanId),
        parentSpanId: openSpan.parentSpanId ? spanIdHex(openSpan.parentSpanId) : undefined,
        name: `${openSpan.name} (unclosed)`,
        kind: 1,
        startTimeUnixNano: msToNano(openSpan.startMs),
        endTimeUnixNano: msToNano(lastMs),
        attributes: compact([
          ...openSpan.attributes,
          strAttr("agentstep.span.status", "unclosed"),
        ]),
        status: { code: STATUS_CODE_ERROR, message: "unclosed span" },
      });
    }
  }

  return spans;
}

/**
 * Build the full OTLP/HTTP JSON payload for a trace.
 */
export function buildOtlpPayload(events: EventRow[], traceId: string): OtlpPayload {
  const spans = traceToOtlpSpans(events, traceId);
  return {
    resourceSpans: [
      {
        resource: {
          attributes: compact([
            strAttr("service.name", "agentstep-gateway"),
            strAttr("service.version", process.env.GATEWAY_VERSION ?? "unknown"),
          ]),
        },
        scopeSpans: [
          {
            scope: { name: "@agentstep/agent-sdk", version: "0.2.10" },
            spans,
          },
        ],
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Export — synchronous build, async POST
// ─────────────────────────────────────────────────────────────────────────

export interface ExportResult {
  ok: boolean;
  status?: number;
  error?: string;
  spanCount: number;
  traceId: string;
}

/**
 * Fetch events for a trace and POST them to the configured OTLP endpoint.
 * Returns an `ExportResult` — the post-commit hook fires this
 * fire-and-forget and logs the outcome.
 */
export async function exportTrace(traceId: string): Promise<ExportResult> {
  const cfg = getConfig();
  if (!cfg.otlpEndpoint) {
    return { ok: false, error: "no OTLP endpoint configured", spanCount: 0, traceId };
  }

  const events = listEventsByTrace(traceId);
  if (events.length === 0) {
    return { ok: false, error: "trace is empty", spanCount: 0, traceId };
  }

  const payload = buildOtlpPayload(events, traceId);
  const spanCount = payload.resourceSpans[0].scopeSpans[0].spans.length;
  if (spanCount === 0) {
    return { ok: false, error: "no spans to export", spanCount: 0, traceId };
  }

  const url = cfg.otlpEndpoint.endsWith("/v1/traces")
    ? cfg.otlpEndpoint
    : `${cfg.otlpEndpoint.replace(/\/+$/, "")}/v1/traces`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.otlpAuthorization ? { Authorization: cfg.otlpAuthorization } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error: `OTLP export failed: ${res.status} ${body.slice(0, 200)}`,
        spanCount,
        traceId,
      };
    }
    return { ok: true, status: res.status, spanCount, traceId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      spanCount,
      traceId,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Auto-export on root-turn-end
// ─────────────────────────────────────────────────────────────────────────

let installed = false;

/**
 * Install the post-commit hook that auto-exports traces when the root
 * turn closes. Safe to call multiple times — internally guarded.
 *
 * Root turn = a `span.model_request_end` where the session has no
 * parent session AND the event carries `parent_span_id IS NULL`. Both
 * conditions must hold so sub-agent end-of-turn events don't trigger
 * premature exports while the parent is still collecting child spans.
 */
export function installOtlpExporter(): void {
  if (installed) return;
  installed = true;

  onAfterCommit((sessionId, row) => {
    if (row.type !== "span.model_request_end") return;
    if (row.parent_span_id != null) return;
    if (!row.trace_id) return;

    // Must be a top-level session, not a thread child
    const sess = getSessionRow(sessionId);
    if (sess?.parent_session_id) return;

    // Fire-and-forget — never block the writer
    void exportTrace(row.trace_id).then((result) => {
      if (!result.ok) {
        console.warn(`[otlp] export failed for ${row.trace_id}: ${result.error}`);
      } else if (process.env.DEBUG_OTLP) {
        console.log(
          `[otlp] exported trace ${row.trace_id}: ${result.spanCount} spans → ${result.status}`,
        );
      }
    });
  });
}
