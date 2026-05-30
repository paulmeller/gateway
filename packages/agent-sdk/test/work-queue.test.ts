// @ts-nocheck — test file with loose typing on handler responses
/**
 * Work queue tests.
 *
 * Covers the DB layer (CRUD, atomic poll, lease expiry, ack, heartbeat,
 * complete, fail, stop, metadata, stats) and the HTTP handler layer
 * (list, poll, ack, heartbeat, stats, cloud-env rejection, self-hosted
 * event dispatch).
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure (mirrors api-comprehensive.test.ts)
// ---------------------------------------------------------------------------

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-work-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
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

async function bootDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-work" });
  return key;
}

function req(
  url: string,
  opts: { method?: string; body?: unknown; apiKey?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.apiKey !== undefined) {
    if (opts.apiKey !== "") headers["x-api-key"] = opts.apiKey;
  } else {
    headers["x-api-key"] = "test-api-key-work";
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/** Seed a self_hosted environment (state = ready) + a cloud environment. */
async function seedFixtures() {
  const { createEnvironment, updateEnvironmentState } = await import("../src/db/environments");
  const { createAgent } = await import("../src/db/agents");
  const { createSession } = await import("../src/db/sessions");

  const selfHostedEnv = createEnvironment({
    name: "test-self-hosted",
    config: { type: "self_hosted" },
  });
  updateEnvironmentState(selfHostedEnv.id, "ready");

  const cloudEnv = createEnvironment({
    name: "test-cloud",
    config: { type: "cloud" },
  });
  updateEnvironmentState(cloudEnv.id, "ready");

  const agent = createAgent({ name: "test-agent", model: "test-model" });

  const session = createSession({
    agent_id: agent.id,
    agent_version: agent.version,
    environment_id: selfHostedEnv.id,
  });

  return {
    selfHostedEnvId: selfHostedEnv.id,
    cloudEnvId: cloudEnv.id,
    agentId: agent.id,
    agentVersion: agent.version,
    sessionId: session.id,
  };
}

// ===========================================================================
// DB layer tests
// ===========================================================================

describe("work queue — DB layer", () => {
  beforeEach(() => freshDbEnv());

  // 1. Create
  it("creates a work item in queued state with correct fields", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem } = await import("../src/db/work");

    const item = createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    expect(item.type).toBe("work");
    expect(item.id).toMatch(/^work_/);
    expect(item.environment_id).toBe(fx.selfHostedEnvId);
    expect(item.state).toBe("queued");
    expect(item.data).toEqual({ type: "session", id: fx.sessionId });
    expect(item.metadata).toEqual({});
    expect(item.worker_id).toBeNull();
    expect(item.created_at).toBeTruthy();
    expect(item.acknowledged_at).toBeNull();
    expect(item.started_at).toBeNull();
    expect(item.latest_heartbeat_at).toBeNull();
    expect(item.stop_requested_at).toBeNull();
    expect(item.stopped_at).toBeNull();
  });

  // 2. Get
  it("retrieves a work item by ID", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, getWorkItem } = await import("../src/db/work");

    const created = createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const fetched = getWorkItem(created.id);

    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.state).toBe("queued");
  });

  it("returns undefined for missing work item", async () => {
    await bootDb();
    const { getWorkItem } = await import("../src/db/work");

    const fetched = getWorkItem("work_nonexistent");
    expect(fetched).toBeUndefined();
  });

  // 3. List
  it("lists items for environment, respects limit and state filter", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, listWorkItems, pollWorkItem } = await import("../src/db/work");

    // Create 3 work items
    const w1 = createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const w2 = createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const w3 = createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    // Default list: all items (ordered by created_at DESC)
    const all = listWorkItems(fx.selfHostedEnvId);
    expect(all).toHaveLength(3);
    const allIds = new Set(all.map((i) => i.id));
    expect(allIds).toContain(w1.id);
    expect(allIds).toContain(w2.id);
    expect(allIds).toContain(w3.id);

    // Limit
    const limited = listWorkItems(fx.selfHostedEnvId, { limit: 2 });
    expect(limited).toHaveLength(2);

    // Poll one item to transition it to pending
    pollWorkItem(fx.selfHostedEnvId);

    // Filter by state
    const queued = listWorkItems(fx.selfHostedEnvId, { state: "queued" });
    expect(queued).toHaveLength(2);

    const pending = listWorkItems(fx.selfHostedEnvId, { state: "pending" });
    expect(pending).toHaveLength(1);
  });

  // 4. Atomic poll — claims oldest queued, transitions to pending
  it("atomic poll claims oldest queued item and transitions to pending", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem } = await import("../src/db/work");

    const w1 = createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const w2 = createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    const claimed = pollWorkItem(fx.selfHostedEnvId, "worker-1");

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(w1.id); // oldest first
    expect(claimed!.state).toBe("pending");
    expect(claimed!.worker_id).toBe("worker-1");
  });

  // 5. Poll empty
  it("poll returns null when no queued items", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { pollWorkItem } = await import("../src/db/work");

    const claimed = pollWorkItem(fx.selfHostedEnvId);
    expect(claimed).toBeNull();
  });

  // 6. Poll race — two polls, only one succeeds per item
  it("two polls on same queue each get a different item", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem } = await import("../src/db/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    const first = pollWorkItem(fx.selfHostedEnvId, "worker-A");
    const second = pollWorkItem(fx.selfHostedEnvId, "worker-B");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.id).not.toBe(second!.id);
  });

  it("second poll returns null when only one item exists", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem } = await import("../src/db/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    const first = pollWorkItem(fx.selfHostedEnvId, "worker-A");
    const second = pollWorkItem(fx.selfHostedEnvId, "worker-B");

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  // 7. Lease expiry — expired pending items reclaimed on next poll
  it("expired pending items get reclaimed to queued on next poll", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem } = await import("../src/db/work");
    const { getDrizzle } = await import("../src/db/drizzle");
    const { sql } = await import("drizzle-orm");

    const w1 = createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    // Poll to claim the item
    const claimed = pollWorkItem(fx.selfHostedEnvId, "worker-1");
    expect(claimed).not.toBeNull();
    expect(claimed!.state).toBe("pending");

    // No more items to poll
    const empty = pollWorkItem(fx.selfHostedEnvId, "worker-2");
    expect(empty).toBeNull();

    // Force-expire the lease by backdating lease_expires_at
    const db = getDrizzle();
    db.run(
      sql`UPDATE work_items SET lease_expires_at = ${Date.now() - 120_000} WHERE id = ${claimed!.id}`,
    );

    // Next poll should reclaim the expired item
    const reclaimed = pollWorkItem(fx.selfHostedEnvId, "worker-2");
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.id).toBe(w1.id);
    expect(reclaimed!.state).toBe("pending");
    expect(reclaimed!.worker_id).toBe("worker-2");
  });

  // 8. Ack — transitions pending → active
  it("ack transitions pending item to active with timestamps", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem } = await import("../src/db/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId, "worker-1");
    expect(claimed).not.toBeNull();

    const acked = ackWorkItem(claimed!.id, "worker-1");
    expect(acked).toBeDefined();
    expect(acked!.state).toBe("active");
    expect(acked!.acknowledged_at).toBeTruthy();
    expect(acked!.started_at).toBeTruthy();
  });

  // 9. Ack wrong state — returns undefined for non-pending
  it("ack returns undefined for queued (non-pending) items", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, ackWorkItem } = await import("../src/db/work");

    const item = createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const result = ackWorkItem(item.id);
    expect(result).toBeUndefined();
  });

  it("ack returns undefined for already-active items", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem } = await import("../src/db/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId);
    ackWorkItem(claimed!.id);

    // Second ack should fail (already active, not pending)
    const secondAck = ackWorkItem(claimed!.id);
    expect(secondAck).toBeUndefined();
  });

  // 10. Heartbeat — extends lease
  it("heartbeat extends lease and returns lease_extended: true", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem, heartbeatWorkItem } = await import("../src/db/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId);
    ackWorkItem(claimed!.id);

    const hb = heartbeatWorkItem(claimed!.id);
    expect(hb).toBeDefined();
    expect(hb!.type).toBe("work_heartbeat");
    expect(hb!.lease_extended).toBe(true);
    expect(hb!.state).toBe("active");
    expect(hb!.ttl_seconds).toBe(60);
    expect(hb!.last_heartbeat).toBeTruthy();
  });

  // 11. Heartbeat terminal — returns lease_extended: false for completed/failed
  it("heartbeat returns lease_extended: false for completed items", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem, completeWorkItem, heartbeatWorkItem } = await import("../src/db/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId);
    ackWorkItem(claimed!.id);
    completeWorkItem(claimed!.id, "completed");

    const hb = heartbeatWorkItem(claimed!.id);
    expect(hb).toBeDefined();
    expect(hb!.lease_extended).toBe(false);
    expect(hb!.state).toBe("completed");
    expect(hb!.ttl_seconds).toBe(0);
  });

  it("heartbeat returns lease_extended: false for failed items", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem, completeWorkItem, heartbeatWorkItem } = await import("../src/db/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId);
    ackWorkItem(claimed!.id);
    completeWorkItem(claimed!.id, "failed");

    const hb = heartbeatWorkItem(claimed!.id);
    expect(hb).toBeDefined();
    expect(hb!.lease_extended).toBe(false);
    expect(hb!.state).toBe("failed");
  });

  // 12. Complete — marks as completed, clears lease
  it("complete marks item as completed with stopped_at", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem, completeWorkItem } = await import("../src/db/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId);
    ackWorkItem(claimed!.id);

    const completed = completeWorkItem(claimed!.id, "completed");
    expect(completed).toBeDefined();
    expect(completed!.state).toBe("completed");
    expect(completed!.stopped_at).toBeTruthy();
  });

  // 13. Fail — marks as failed, clears lease
  it("fail marks item as failed with stopped_at", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem, completeWorkItem } = await import("../src/db/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId);
    ackWorkItem(claimed!.id);

    const failed = completeWorkItem(claimed!.id, "failed");
    expect(failed).toBeDefined();
    expect(failed!.state).toBe("failed");
    expect(failed!.stopped_at).toBeTruthy();
  });

  // 14. Stop — sets stop_requested_at
  it("stop sets stop_requested_at without changing state", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem, stopWorkItem } = await import("../src/db/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId);
    ackWorkItem(claimed!.id);

    const stopped = stopWorkItem(claimed!.id);
    expect(stopped).toBeDefined();
    expect(stopped!.stop_requested_at).toBeTruthy();
    expect(stopped!.state).toBe("active"); // non-force keeps current state
    expect(stopped!.stopped_at).toBeNull();
  });

  // 15. Force stop — immediately fails the item
  it("force stop immediately fails the item", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem, stopWorkItem } = await import("../src/db/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId);
    ackWorkItem(claimed!.id);

    const stopped = stopWorkItem(claimed!.id, true);
    expect(stopped).toBeDefined();
    expect(stopped!.state).toBe("failed");
    expect(stopped!.stop_requested_at).toBeTruthy();
    expect(stopped!.stopped_at).toBeTruthy();
  });

  // 16. Metadata update — merges keys, null deletes
  it("metadata update merges keys and null deletes", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, updateWorkItemMetadata } = await import("../src/db/work");

    const item = createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    expect(item.metadata).toEqual({});

    // Add keys
    const updated1 = updateWorkItemMetadata(item.id, { foo: "bar", baz: "qux" });
    expect(updated1).toBeDefined();
    expect(updated1!.metadata).toEqual({ foo: "bar", baz: "qux" });

    // Merge: add new, keep old
    const updated2 = updateWorkItemMetadata(item.id, { hello: "world" });
    expect(updated2!.metadata).toEqual({ foo: "bar", baz: "qux", hello: "world" });

    // Delete with null
    const updated3 = updateWorkItemMetadata(item.id, { baz: null });
    expect(updated3!.metadata).toEqual({ foo: "bar", hello: "world" });
  });

  it("metadata update returns undefined for missing item", async () => {
    await bootDb();
    const { updateWorkItemMetadata } = await import("../src/db/work");
    const result = updateWorkItemMetadata("work_nonexistent", { foo: "bar" });
    expect(result).toBeUndefined();
  });

  // 17. Stats
  it("stats returns correct depth, pending, oldest_queued_at", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem, getWorkQueueStats } = await import("../src/db/work");

    // Empty stats
    const empty = getWorkQueueStats(fx.selfHostedEnvId);
    expect(empty.type).toBe("work_queue_stats");
    expect(empty.depth).toBe(0);
    expect(empty.pending).toBe(0);
    expect(empty.oldest_queued_at).toBeNull();

    // Create 3 items
    const w1 = createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    const stats1 = getWorkQueueStats(fx.selfHostedEnvId);
    expect(stats1.depth).toBe(3);
    expect(stats1.pending).toBe(0);
    expect(stats1.oldest_queued_at).toBeTruthy();

    // Poll one (queued -> pending)
    pollWorkItem(fx.selfHostedEnvId, "w1");
    const stats2 = getWorkQueueStats(fx.selfHostedEnvId);
    expect(stats2.depth).toBe(2);
    expect(stats2.pending).toBe(1);
    expect(stats2.workers_polling).toBe(1);

    // Ack it (pending -> active)
    const claimed = pollWorkItem(fx.selfHostedEnvId, "w1"); // poll second item
    ackWorkItem(claimed!.id, "w1");
    const stats3 = getWorkQueueStats(fx.selfHostedEnvId);
    expect(stats3.depth).toBe(1);
    // pending count includes both pending + active
    expect(stats3.pending).toBe(2);
  });
});

// ===========================================================================
// HTTP handler tests
// ===========================================================================

describe("work queue — HTTP handlers", () => {
  beforeEach(() => freshDbEnv());

  // 18. GET /environments/:id/work — list
  it("GET /environments/:id/work returns paginated list", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem } = await import("../src/db/work");
    const { handleListWork } = await import("../src/handlers/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    const res = await handleListWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work`),
      fx.selfHostedEnvId,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(3);
    expect(body.data[0].type).toBe("work");
  });

  it("GET /environments/:id/work respects limit and returns has_more pagination", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem } = await import("../src/db/work");
    const { getDrizzle } = await import("../src/db/drizzle");
    const { handleListWork } = await import("../src/handlers/work");
    const { sql } = await import("drizzle-orm");

    // Create 5 items with distinct created_at timestamps so cursor pagination works
    const db = getDrizzle();
    const { newId } = await import("../src/util/ids");
    const baseTime = Date.now();
    for (let i = 0; i < 5; i++) {
      const id = newId("work");
      db.run(
        sql`INSERT INTO work_items (id, environment_id, session_id, state, metadata_json, created_at)
            VALUES (${id}, ${fx.selfHostedEnvId}, ${fx.sessionId}, 'queued', '{}', ${baseTime + i})`,
      );
    }

    const res = await handleListWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work?limit=3`),
      fx.selfHostedEnvId,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(3);
    expect(body.has_more).toBe(true);
    expect(body.last_id).toBeTypeOf("string");

    // Fetch page 2 using last_id as after_id cursor
    const res2 = await handleListWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work?limit=3&after_id=${body.last_id}`),
      fx.selfHostedEnvId,
    );
    const body2 = await res2.json();
    expect(body2.data).toHaveLength(2);
  });

  // 19. GET /environments/:id/work/poll — poll
  it("GET /environments/:id/work/poll returns work item or null", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem } = await import("../src/db/work");
    const { handlePollWork } = await import("../src/handlers/work");

    // Poll on empty queue
    const emptyRes = await handlePollWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work/poll`),
      fx.selfHostedEnvId,
    );
    expect(emptyRes.status).toBe(200);
    const emptyBody = await emptyRes.json();
    expect(emptyBody.data).toBeNull();

    // Create an item and poll again
    createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    const res = await handlePollWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work/poll?worker_id=test-worker`),
      fx.selfHostedEnvId,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("work");
    expect(body.state).toBe("pending");
    expect(body.worker_id).toBe("test-worker");
  });

  // 20. POST /environments/:id/work/:id/ack
  it("POST /environments/:id/work/:id/ack acknowledges pending item", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem } = await import("../src/db/work");
    const { handleAckWork } = await import("../src/handlers/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId, "worker-1");

    const res = await handleAckWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work/${claimed!.id}/ack`, {
        method: "POST",
        body: { worker_id: "worker-1" },
      }),
      fx.selfHostedEnvId,
      claimed!.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("active");
    expect(body.acknowledged_at).toBeTruthy();
  });

  it("POST ack returns 404 for non-pending item", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem } = await import("../src/db/work");
    const { handleAckWork } = await import("../src/handlers/work");

    const item = createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    // Item is queued, not pending — ack should fail
    const res = await handleAckWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work/${item.id}/ack`, {
        method: "POST",
        body: {},
      }),
      fx.selfHostedEnvId,
      item.id,
    );
    expect(res.status).toBe(404);
  });

  // 21. POST /environments/:id/work/:id/heartbeat
  it("POST /environments/:id/work/:id/heartbeat extends lease", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem } = await import("../src/db/work");
    const { handleHeartbeatWork } = await import("../src/handlers/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId);
    ackWorkItem(claimed!.id);

    const res = await handleHeartbeatWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work/${claimed!.id}/heartbeat`, {
        method: "POST",
        body: {},
      }),
      fx.selfHostedEnvId,
      claimed!.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("work_heartbeat");
    expect(body.lease_extended).toBe(true);
    expect(body.ttl_seconds).toBe(60);
  });

  // 22. GET /environments/:id/work/stats
  it("GET /environments/:id/work/stats returns queue stats", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem } = await import("../src/db/work");
    const { handleWorkStats } = await import("../src/handlers/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    const res = await handleWorkStats(
      req(`/v1/environments/${fx.selfHostedEnvId}/work/stats`),
      fx.selfHostedEnvId,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("work_queue_stats");
    expect(body.depth).toBe(2);
    expect(body.pending).toBe(0);
  });

  // 23. Rejects on cloud env — work endpoints return 400
  it("list work returns 400 on cloud environment", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { handleListWork } = await import("../src/handlers/work");

    const res = await handleListWork(
      req(`/v1/environments/${fx.cloudEnvId}/work`),
      fx.cloudEnvId,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("self_hosted");
  });

  it("poll work returns 400 on cloud environment", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { handlePollWork } = await import("../src/handlers/work");

    const res = await handlePollWork(
      req(`/v1/environments/${fx.cloudEnvId}/work/poll`),
      fx.cloudEnvId,
    );
    expect(res.status).toBe(400);
  });

  it("stats returns 400 on cloud environment", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { handleWorkStats } = await import("../src/handlers/work");

    const res = await handleWorkStats(
      req(`/v1/environments/${fx.cloudEnvId}/work/stats`),
      fx.cloudEnvId,
    );
    expect(res.status).toBe(400);
  });

  it("ack returns 400 on cloud environment", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { handleAckWork } = await import("../src/handlers/work");

    const res = await handleAckWork(
      req(`/v1/environments/${fx.cloudEnvId}/work/fake-id/ack`, { method: "POST", body: {} }),
      fx.cloudEnvId,
      "fake-id",
    );
    expect(res.status).toBe(400);
  });

  it("heartbeat returns 400 on cloud environment", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { handleHeartbeatWork } = await import("../src/handlers/work");

    const res = await handleHeartbeatWork(
      req(`/v1/environments/${fx.cloudEnvId}/work/fake-id/heartbeat`, { method: "POST", body: {} }),
      fx.cloudEnvId,
      "fake-id",
    );
    expect(res.status).toBe(400);
  });

  // handleStopWork and handleUpdateWork on cloud env
  it("stop returns 400 on cloud environment", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { handleStopWork } = await import("../src/handlers/work");

    const res = await handleStopWork(
      req(`/v1/environments/${fx.cloudEnvId}/work/fake-id/stop`, { method: "POST", body: {} }),
      fx.cloudEnvId,
      "fake-id",
    );
    expect(res.status).toBe(400);
  });

  it("update metadata returns 400 on cloud environment", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { handleUpdateWork } = await import("../src/handlers/work");

    const res = await handleUpdateWork(
      req(`/v1/environments/${fx.cloudEnvId}/work/fake-id`, { method: "PATCH", body: { metadata: { k: "v" } } }),
      fx.cloudEnvId,
      "fake-id",
    );
    expect(res.status).toBe(400);
  });

  // handleGetWork
  it("GET /environments/:id/work/:id returns a specific work item", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem } = await import("../src/db/work");
    const { handleGetWork } = await import("../src/handlers/work");

    const item = createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    const res = await handleGetWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work/${item.id}`),
      fx.selfHostedEnvId,
      item.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(item.id);
    expect(body.state).toBe("queued");
  });

  it("GET /environments/:id/work/:id returns 404 for missing item", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { handleGetWork } = await import("../src/handlers/work");

    const res = await handleGetWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work/work_nonexistent`),
      fx.selfHostedEnvId,
      "work_nonexistent",
    );
    expect(res.status).toBe(404);
  });

  // handleStopWork via HTTP
  it("POST stop sets stop_requested_at via handler", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem } = await import("../src/db/work");
    const { handleStopWork } = await import("../src/handlers/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId);
    ackWorkItem(claimed!.id);

    const res = await handleStopWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work/${claimed!.id}/stop`, {
        method: "POST",
        body: {},
      }),
      fx.selfHostedEnvId,
      claimed!.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stop_requested_at).toBeTruthy();
    expect(body.state).toBe("active");
  });

  it("POST force stop fails the item via handler", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem, pollWorkItem, ackWorkItem } = await import("../src/db/work");
    const { handleStopWork } = await import("../src/handlers/work");

    createWorkItem(fx.selfHostedEnvId, fx.sessionId);
    const claimed = pollWorkItem(fx.selfHostedEnvId);
    ackWorkItem(claimed!.id);

    const res = await handleStopWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work/${claimed!.id}/stop`, {
        method: "POST",
        body: { force: true },
      }),
      fx.selfHostedEnvId,
      claimed!.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("failed");
    expect(body.stopped_at).toBeTruthy();
  });

  // handleUpdateWork via HTTP
  it("PATCH update metadata merges keys via handler", async () => {
    await bootDb();
    const fx = await seedFixtures();
    const { createWorkItem } = await import("../src/db/work");
    const { handleUpdateWork } = await import("../src/handlers/work");

    const item = createWorkItem(fx.selfHostedEnvId, fx.sessionId);

    const res = await handleUpdateWork(
      req(`/v1/environments/${fx.selfHostedEnvId}/work/${item.id}`, {
        method: "PATCH",
        body: { metadata: { key1: "val1", key2: "val2" } },
      }),
      fx.selfHostedEnvId,
      item.id,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadata).toEqual({ key1: "val1", key2: "val2" });
  });
});

// ===========================================================================
// Event handler integration — self_hosted dispatch
// ===========================================================================

describe("work queue — self_hosted event dispatch", () => {
  beforeEach(() => freshDbEnv());

  // 24. POST /sessions/:id/events on self_hosted session creates work item
  // (only queues when no inline executor — clear DEFAULT_PROVIDER to simulate)
  it("posting a user.message event on self_hosted session creates a work item", async () => {
    const saved = process.env.DEFAULT_PROVIDER;
    delete process.env.DEFAULT_PROVIDER;
    await bootDb();
    const fx = await seedFixtures();
    const { handlePostEvents } = await import("../src/handlers/anthropic-compat/events");
    const { listWorkItems } = await import("../src/db/work");

    // Verify no work items initially
    const before = listWorkItems(fx.selfHostedEnvId);
    expect(before).toHaveLength(0);

    // Post a user.message event
    const res = await handlePostEvents(
      req(`/anthropic/v1/sessions/${fx.sessionId}/events`, {
        method: "POST",
        body: {
          events: [
            { type: "user.message", content: [{ type: "text", text: "Hello from test" }] },
          ],
        },
      }),
      fx.sessionId,
    );
    expect(res.status).toBe(200);

    // A work item should have been created for the self_hosted environment
    const after = listWorkItems(fx.selfHostedEnvId);
    expect(after).toHaveLength(1);
    expect(after[0].state).toBe("queued");
    expect(after[0].data).toEqual({ type: "session", id: fx.sessionId });
    expect(after[0].environment_id).toBe(fx.selfHostedEnvId);

    // Restore
    if (saved) process.env.DEFAULT_PROVIDER = saved;
    else delete process.env.DEFAULT_PROVIDER;
  });
});
