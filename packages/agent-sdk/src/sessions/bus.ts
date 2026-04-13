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

export function appendEvent(sessionId: string, input: AppendInput): EventRow {
  const row = dbAppend(sessionId, input);
  getOrCreateEmitter(sessionId).emit("event", row);
  fireWebhook(sessionId, row);
  return row;
}

export function appendEventsBatch(sessionId: string, inputs: AppendInput[]): EventRow[] {
  const rows = dbAppendBatch(sessionId, inputs);
  const em = getOrCreateEmitter(sessionId);
  for (const row of rows) {
    em.emit("event", row);
    fireWebhook(sessionId, row);
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
