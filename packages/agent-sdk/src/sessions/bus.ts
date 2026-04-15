/**
 * Session event bus: append-only log + EventEmitter fan-out.
 *
 * The DB is authoritative; the emitter is the live tail. Callers mutate the
 * session log exclusively through `appendEvent` / `appendEventsBatch`, which
 * insert under an IMMEDIATE transaction and THEN emit post-commit. This is
 * how the Managed Agents stream-first reconnect contract works: subscribers
 * can attach anytime, backfill from the DB, and keep tailing the emitter.
 *
 * Every append MUST be invoked from inside the corresponding session's
 * `SessionActor` (see `lib/sessions/actor.ts`) to preserve ordering.
 *
 * ## Post-commit hooks
 *
 * `onAfterCommit(fn)` registers a synchronous callback that fires with
 * every inserted row AFTER the DB transaction. Used by the OTLP exporter
 * to trigger trace flush when a root turn span closes, and by cost
 * rollup/alerting in the future. Errors in hooks are swallowed — they
 * never propagate back to the writer.
 *
 * ## PII redaction
 *
 * `installPayloadRedactor(fn)` lets callers replace the event payload
 * before it's serialized and inserted. Consumed by `redactor.ts` which
 * strips known secrets (vault values, config tokens, `redactEnvKeys`)
 * from stdout/stderr blocks. Applied to every `AppendInput` inside this
 * module so no writer can bypass it.
 */
import { EventEmitter } from "node:events";
import {
  appendEvent as dbAppend,
  appendEventsBatch as dbAppendBatch,
  listEvents,
  rowToManagedEvent,
  type AppendInput,
} from "../db/events";
import { getSession } from "../db/sessions";
import { getAgent } from "../db/agents";
import type { EventRow, ManagedEvent } from "../types";

type GlobalBus = typeof globalThis & {
  __caBusEmitters?: Map<string, EventEmitter>;
};

function emitters(): Map<string, EventEmitter> {
  const g = globalThis as GlobalBus;
  if (!g.__caBusEmitters) g.__caBusEmitters = new Map();
  return g.__caBusEmitters;
}

/** Cached webhook config per session — avoids 2 DB reads (getSession + getAgent) per event. */
interface WebhookCacheEntry {
  webhookUrl: string | null;
  webhookEvents: string[];
}
const webhookCache = new Map<string, WebhookCacheEntry>();

function getWebhookConfig(sessionId: string): WebhookCacheEntry {
  const cached = webhookCache.get(sessionId);
  if (cached) return cached;

  const session = getSession(sessionId);
  if (!session) {
    const entry: WebhookCacheEntry = { webhookUrl: null, webhookEvents: [] };
    webhookCache.set(sessionId, entry);
    return entry;
  }
  const agent = getAgent(session.agent.id, session.agent.version);
  const entry: WebhookCacheEntry = {
    webhookUrl: agent?.webhook_url ?? null,
    webhookEvents: agent?.webhook_events ?? [],
  };
  webhookCache.set(sessionId, entry);
  return entry;
}

function getOrCreateEmitter(sessionId: string): EventEmitter {
  const reg = emitters();
  let em = reg.get(sessionId);
  if (!em) {
    em = new EventEmitter();
    em.setMaxListeners(0); // unbounded subscribers per session
    reg.set(sessionId, em);
  }
  return em;
}

function fireWebhook(sessionId: string, row: EventRow): void {
  try {
    const config = getWebhookConfig(sessionId);
    if (!config.webhookUrl) return;
    if (!config.webhookEvents.includes(row.type)) return;

    const payload = JSON.stringify(rowToManagedEvent(row));
    void fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(5000),
    }).catch((err: unknown) => {
      console.warn(`[webhook] POST to ${config.webhookUrl} failed:`, err);
    });
  } catch {
    // best-effort — never let webhook errors propagate
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Post-commit hooks (OTLP exporter, cost rollup, alerting — future)
// ─────────────────────────────────────────────────────────────────────────

type AfterCommitHook = (sessionId: string, row: EventRow) => void;

type GlobalHooks = typeof globalThis & {
  __caBusAfterCommit?: Set<AfterCommitHook>;
  __caBusRedactor?: (input: AppendInput) => AppendInput;
};

function hooks(): Set<AfterCommitHook> {
  const g = globalThis as GlobalHooks;
  if (!g.__caBusAfterCommit) g.__caBusAfterCommit = new Set();
  return g.__caBusAfterCommit;
}

/**
 * Register a synchronous callback that runs once the event row has been
 * committed to the DB and emitted on the live tail. Errors in the hook
 * are swallowed to avoid breaking the writer.
 */
export function onAfterCommit(fn: AfterCommitHook): () => void {
  hooks().add(fn);
  return () => hooks().delete(fn);
}

function fireHooks(sessionId: string, row: EventRow): void {
  for (const fn of hooks()) {
    try {
      fn(sessionId, row);
    } catch (err) {
      console.warn(`[bus] after-commit hook failed:`, err);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PII redaction
// ─────────────────────────────────────────────────────────────────────────

/**
 * Replace the global payload redactor. Typically installed at boot from
 * `observability/redactor.ts` based on config. The redactor is pure:
 * given an `AppendInput`, it returns a new `AppendInput` with any
 * sensitive substrings replaced.
 */
export function installPayloadRedactor(
  fn: ((input: AppendInput) => AppendInput) | null,
): void {
  const g = globalThis as GlobalHooks;
  g.__caBusRedactor = fn ?? undefined;
}

function redact(input: AppendInput): AppendInput {
  const g = globalThis as GlobalHooks;
  const fn = g.__caBusRedactor;
  return fn ? fn(input) : input;
}

export function appendEvent(sessionId: string, input: AppendInput): EventRow {
  const row = dbAppend(sessionId, redact(input));
  getOrCreateEmitter(sessionId).emit("event", row);
  fireWebhook(sessionId, row);
  fireHooks(sessionId, row);
  return row;
}

export function appendEventsBatch(sessionId: string, inputs: AppendInput[]): EventRow[] {
  const rows = dbAppendBatch(sessionId, inputs.map(redact));
  const em = getOrCreateEmitter(sessionId);
  for (const row of rows) {
    em.emit("event", row);
    fireWebhook(sessionId, row);
    fireHooks(sessionId, row);
  }
  return rows;
}

export interface Subscription {
  unsubscribe(): void;
}

/**
 * Subscribe to live events for a session. First emits any backlog rows with
 * `seq > fromSeq` (read from the DB), then attaches a live listener. The
 * backlog read and live attach happen in sequence; a small race is possible
 * where an event lands between the DB read and the listener attach, so the
 * live handler dedupes by tracking `lastDeliveredSeq`.
 */
export function subscribe(
  sessionId: string,
  fromSeq: number,
  onEvent: (evt: ManagedEvent) => void,
): Subscription {
  const em = getOrCreateEmitter(sessionId);
  let lastDeliveredSeq = fromSeq;

  // Backlog drain
  const backlog = listEvents(sessionId, { limit: 500, order: "asc", afterSeq: fromSeq });
  for (const row of backlog) {
    onEvent(rowToManagedEvent(row));
    if (row.seq > lastDeliveredSeq) lastDeliveredSeq = row.seq;
  }

  const handler = (row: EventRow) => {
    if (row.seq <= lastDeliveredSeq) return;
    onEvent(rowToManagedEvent(row));
    lastDeliveredSeq = row.seq;
  };
  em.on("event", handler);

  return {
    unsubscribe() {
      em.off("event", handler);
    },
  };
}

export function dropEmitter(sessionId: string): void {
  const reg = emitters();
  const em = reg.get(sessionId);
  if (em) em.removeAllListeners();
  reg.delete(sessionId);
  webhookCache.delete(sessionId);
}
