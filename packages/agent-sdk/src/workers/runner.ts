/**
 * Work queue worker — polls for work items and executes turns.
 *
 * v1 limitation: co-located only (same machine, same SQLite DB).
 * The worker runs in a separate process but shares the same database file
 * as the API server. It calls runTurn() directly, which reads/writes the
 * shared DB. Events written by the worker are visible to the API server's
 * SSE stream via DB polling (not the process-local EventEmitter).
 *
 * Remote / distributed workers are out of scope for this version.
 */

import { pollWorkItem, ackWorkItem, heartbeatWorkItem, completeWorkItem, getWorkItemInputs } from "../db/work";
import { runTurn } from "../sessions/driver";
import type { TurnInput } from "../state";

export interface WorkerOptions {
  environmentId: string;
  provider?: string;
  pollIntervalMs?: number;
  workerId?: string;
}

export async function startWorker(opts: WorkerOptions): Promise<void> {
  const pollInterval = opts.pollIntervalMs ?? 5_000;
  const workerId = opts.workerId ?? `worker-${process.pid}`;
  let stopping = false;

  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  console.log(`[worker] starting: env=${opts.environmentId} poll=${pollInterval}ms worker=${workerId}`);

  while (!stopping) {
    // Poll for work — atomically claims the oldest queued item
    const item = pollWorkItem(opts.environmentId, workerId);
    if (!item) {
      await new Promise((r) => setTimeout(r, pollInterval));
      continue;
    }

    console.log(`[worker] claimed ${item.id} -> session ${item.data.id}`);

    // Acknowledge — transitions pending -> active
    const acked = ackWorkItem(item.id, workerId);
    if (!acked) {
      console.warn(`[worker] ack failed for ${item.id} — another worker claimed it`);
      continue;
    }

    // Start heartbeat (every 30s) to extend the lease
    const heartbeatTimer = setInterval(() => {
      const result = heartbeatWorkItem(item.id);
      if (result && !result.lease_extended) {
        console.warn(`[worker] heartbeat failed for ${item.id}: state=${result.state}`);
      }
    }, 30_000);

    // Execute the turn
    try {
      // Read the raw inputs_json stored by the event handler when the work
      // item was created (see createWorkItem call site).
      const inputsRaw = getWorkItemInputs(item.id);
      const inputs: TurnInput[] = inputsRaw ? JSON.parse(inputsRaw) : [];

      if (inputs.length > 0) {
        await runTurn(item.data.id, inputs);
      } else {
        console.warn(`[worker] no inputs for ${item.id} — skipping`);
      }

      completeWorkItem(item.id, "completed");
      console.log(`[worker] completed ${item.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[worker] failed ${item.id}: ${msg}`);
      completeWorkItem(item.id, "failed");
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  console.log("[worker] stopped");
}
