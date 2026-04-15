/**
 * Per-session async-serialized actor.
 *
 * This is the concurrency primitive everything else depends on for ordering
 * correctness. One actor per session; all mutating work (append events, run
 * turns, interrupt, archive, delete) goes through `enqueue(fn)` which runs
 * tasks serially in FIFO order.
 *
 * Rationale (plan §Critical fix C2): per-event SQL transactions do not
 * serialize the DECISION to abort with respect to the event stream. A real
 * in-memory lock is required, and the cleanest shape is a FIFO promise chain
 * scoped to the session.
 */
type GlobalActors = typeof globalThis & {
  __caActors?: Map<string, SessionActor>;
};

export class SessionActor {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(public readonly sessionId: string) {}

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    // Swallow errors on the chain so one failed job doesn't kill the actor.
    this.tail = run.catch(() => {});
    return run;
  }
}

function registry(): Map<string, SessionActor> {
  const g = globalThis as GlobalActors;
  if (!g.__caActors) g.__caActors = new Map();
  return g.__caActors;
}

export function getActor(sessionId: string): SessionActor {
  const reg = registry();
  let actor = reg.get(sessionId);
  if (!actor) {
    actor = new SessionActor(sessionId);
    reg.set(sessionId, actor);
  }
  return actor;
}

export function dropActor(sessionId: string): void {
  registry().delete(sessionId);
}

export function allActorIds(): string[] {
  return Array.from(registry().keys());
}
