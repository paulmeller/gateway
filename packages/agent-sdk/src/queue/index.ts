/**
 * Turn-level concurrency queue.
 *
 * Enforces two limits:
 *   - Global: `config.concurrency` (how many turns may run simultaneously
 *     across all sessions/environments)
 *   - Per-environment: `config.maxSpritesPerEnv` (real resource constraint,
 *     since each running turn owns a sprite in its env's pool)
 *
 * Sessions are pinned to sprites 1:1, so a session's active turn naturally
 * consumes one env slot. The queue tracks pending enqueues and releases
 * capacity as turns complete.
 *
 * Pattern inspired by
 * 
 * reparameterized per plan §Important I3.
 */
import { getConfig } from "../config";
import { serverBusy } from "../errors";

interface Job<T> {
  envId: string;
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

type State = {
  queue: Job<unknown>[];
  activeGlobal: number;
  activeByEnv: Map<string, number>;
};

type GlobalQueue = typeof globalThis & { __caQueue?: State };

function state(): State {
  const g = globalThis as GlobalQueue;
  if (!g.__caQueue) {
    g.__caQueue = {
      queue: [],
      activeGlobal: 0,
      activeByEnv: new Map(),
    };
  }
  return g.__caQueue;
}

/**
 * Enqueue a turn-runner against the given environment. Throws `serverBusy`
 * immediately if the queue depth limit is exceeded.
 */
export function enqueueTurn<T>(envId: string, run: () => Promise<T>): Promise<T> {
  const s = state();
  const cfg = getConfig();
  const maxDepth = 100; // generous — each job is lightweight
  if (s.queue.length >= maxDepth) {
    throw serverBusy("turn queue is full");
  }

  return new Promise<T>((resolve, reject) => {
    s.queue.push({
      envId,
      run: run as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    drain();
  });

  function drain(): void {
    const st = state();
    const c = getConfig();
    for (let i = 0; i < st.queue.length; i++) {
      if (st.activeGlobal >= c.concurrency) break;
      const job = st.queue[i];
      const envActive = st.activeByEnv.get(job.envId) ?? 0;
      if (envActive >= c.maxSpritesPerEnv) continue;

      // Take this job
      st.queue.splice(i, 1);
      i--;
      st.activeGlobal++;
      st.activeByEnv.set(job.envId, envActive + 1);

      void (async () => {
        try {
          const r = await job.run();
          job.resolve(r);
        } catch (err) {
          job.reject(err);
        } finally {
          const st2 = state();
          st2.activeGlobal--;
          const envAct = st2.activeByEnv.get(job.envId) ?? 1;
          if (envAct <= 1) st2.activeByEnv.delete(job.envId);
          else st2.activeByEnv.set(job.envId, envAct - 1);
          drain();
        }
      })();
    }
  }
}

export function queueStats() {
  const s = state();
  return {
    queued: s.queue.length,
    activeGlobal: s.activeGlobal,
    activeByEnv: Array.from(s.activeByEnv.entries()),
  };
}
