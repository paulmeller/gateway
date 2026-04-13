import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { EventOrigin, EventRow, ManagedEvent } from "../types";

export interface AppendInput {
  type: string;
  payload: Record<string, unknown>;
  origin: EventOrigin;
  idempotencyKey?: string | null;
  processedAt?: number | null;
}

/**
 * Append an event to a session's log inside an IMMEDIATE transaction.
 *
 * Reserves the next sequence number by reading `sessions.last_seq` and
 * updating it atomically. Honors the partial-unique idempotency_key index —
 * if a matching key already exists for this session, the existing row is
 * returned and no new row is inserted.
 *
 * NOTE: this function does NOT emit on the bus. The caller (typically
 * `lib/sessions/bus.ts`) is responsible for post-commit fan-out, so that
 * the order "commit first, then emit" is guaranteed.
 */
export function appendEvent(sessionId: string, input: AppendInput): EventRow {
  const db = getDb();

  return db.transaction(() => {
    if (input.idempotencyKey) {
      const dupe = db
        .prepare(
          `SELECT * FROM events WHERE session_id = ? AND idempotency_key = ?`,
        )
        .get(sessionId, input.idempotencyKey) as EventRow | undefined;
      if (dupe) return dupe;
    }

    const row = db
      .prepare(
        `SELECT last_seq FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as { last_seq: number } | undefined;
    if (!row) throw new Error(`session not found: ${sessionId}`);

    const seq = row.last_seq + 1;
    const id = newId("evt");
    const receivedAt = nowMs();

    db.prepare(
      `INSERT INTO events (
         id, session_id, seq, type, payload_json,
         processed_at, received_at, origin, idempotency_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sessionId,
      seq,
      input.type,
      JSON.stringify(input.payload),
      input.processedAt ?? null,
      receivedAt,
      input.origin,
      input.idempotencyKey ?? null,
    );

    db.prepare(`UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?`).run(
      seq,
      receivedAt,
      sessionId,
    );

    return {
      id,
      session_id: sessionId,
      seq,
      type: input.type,
      payload_json: JSON.stringify(input.payload),
      processed_at: input.processedAt ?? null,
      received_at: receivedAt,
      origin: input.origin,
      idempotency_key: input.idempotencyKey ?? null,
    };
  })();
}

/**
 * Append multiple events in a single transaction. Returns the inserted rows
 * in input order. Same idempotency semantics per row.
 */
export function appendEventsBatch(sessionId: string, inputs: AppendInput[]): EventRow[] {
  const db = getDb();

  return db.transaction(() => {
    const rows: EventRow[] = [];
    for (const input of inputs) {
      if (input.idempotencyKey) {
        const dupe = db
          .prepare(
            `SELECT * FROM events WHERE session_id = ? AND idempotency_key = ?`,
          )
          .get(sessionId, input.idempotencyKey) as EventRow | undefined;
        if (dupe) {
          rows.push(dupe);
          continue;
        }
      }

      const cur = db
        .prepare(
          `SELECT last_seq FROM sessions WHERE id = ?`,
        )
        .get(sessionId) as { last_seq: number } | undefined;
      if (!cur) throw new Error(`session not found: ${sessionId}`);

      const seq = cur.last_seq + 1;
      const id = newId("evt");
      const receivedAt = nowMs();

      db.prepare(
        `INSERT INTO events (
           id, session_id, seq, type, payload_json,
           processed_at, received_at, origin, idempotency_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        sessionId,
        seq,
        input.type,
        JSON.stringify(input.payload),
        input.processedAt ?? null,
        receivedAt,
        input.origin,
        input.idempotencyKey ?? null,
      );

      db.prepare(`UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?`).run(
        seq,
        receivedAt,
        sessionId,
      );

      rows.push({
        id,
        session_id: sessionId,
        seq,
        type: input.type,
        payload_json: JSON.stringify(input.payload),
        processed_at: input.processedAt ?? null,
        received_at: receivedAt,
        origin: input.origin,
        idempotency_key: input.idempotencyKey ?? null,
      });
    }
    return rows;
  })();
}

export function markUserEventProcessed(eventId: string, when: number): void {
  const db = getDb();
  db.prepare(`UPDATE events SET processed_at = ? WHERE id = ?`).run(when, eventId);
}

export function listEvents(
  sessionId: string,
  opts: {
    limit?: number;
    order?: "asc" | "desc";
    afterSeq?: number;
  },
): EventRow[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const order = opts.order === "desc" ? "DESC" : "ASC";
  const afterSeq = opts.afterSeq ?? 0;

  return db
    .prepare(
      `SELECT * FROM events
       WHERE session_id = ? AND seq > ?
       ORDER BY seq ${order}
       LIMIT ?`,
    )
    .all(sessionId, afterSeq, limit) as EventRow[];
}

export function getLastUnprocessedUserMessage(sessionId: string): EventRow | null {
  const db = getDb();
  return (
    (db
      .prepare(
        `SELECT * FROM events WHERE session_id = ? AND type = 'user.message' AND processed_at IS NULL ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId) as EventRow | undefined) ?? null
  );
}

export function rowToManagedEvent(row: EventRow): ManagedEvent {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  return {
    id: row.id,
    seq: row.seq,
    session_id: row.session_id,
    type: row.type,
    processed_at: row.processed_at != null ? toIso(row.processed_at) : null,
    ...payload,
  };
}
