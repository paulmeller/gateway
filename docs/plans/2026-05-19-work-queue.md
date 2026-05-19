# Work Queue — Horizontal Scaling via Worker Polling

## Problem

Today, the gateway API server and execution engine run in the same process. `POST /v1/sessions/:id/events` triggers a turn that runs the agent CLI inside a container — all synchronous, single-process. This limits scaling: one gateway process can only run `CONCURRENCY` (default 4) turns simultaneously.

For production deployments, the API server and execution workers should be separable. Multiple worker processes (possibly on different machines) should be able to pull work from a central queue and execute turns independently.

## Solution

Implement the Anthropic self-hosted work queue API on AgentStep. The environment config gets a new `self_hosted` type. When a session turn is triggered on a self-hosted environment, instead of executing locally, the gateway queues a work item. Worker processes poll for work, execute turns, and heartbeat results back.

## Architecture

```
                    ┌─────────────────┐
                    │  AgentStep API   │
                    │  (gateway serve) │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   Work Queue    │
                    │  (SQLite/DB)    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼──────┐ ┌────▼───────┐ ┌────▼───────┐
     │   Worker 1    │ │  Worker 2  │ │  Worker 3  │
     │ (docker)      │ │ (sprites)  │ │ (mvm)      │
     └───────────────┘ └────────────┘ └────────────┘
```

**Single-process mode (default, no change):** Environment `type: "cloud"` works exactly as today. The API server executes turns directly. No queue involved.

**Worker mode:** Environment `type: "self_hosted"`. Turns are queued. Workers poll and execute.

## API Endpoints (matching Anthropic spec)

### Environment config

```json
POST /v1/environments
{
  "name": "production",
  "config": { "type": "self_hosted" }
}
```

### Work queue endpoints

All scoped to an environment:

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/environments/:id/work` | List work items (all states) |
| `GET` | `/v1/environments/:id/work/:workId` | Get single work item |
| `POST` | `/v1/environments/:id/work/:workId` | Update work item metadata |
| `GET` | `/v1/environments/:id/work/poll` | Long-poll for next work item |
| `GET` | `/v1/environments/:id/work/stats` | Queue depth, pending count, active workers |
| `POST` | `/v1/environments/:id/work/:workId/ack` | Worker acknowledges work (claims it) |
| `POST` | `/v1/environments/:id/work/:workId/heartbeat` | Worker heartbeat (extends lease) |
| `POST` | `/v1/environments/:id/work/:workId/stop` | Request graceful stop |

### Work item lifecycle

```
queued → pending (polled) → active (acked) → completed/failed
                                    ↑
                              heartbeat (extends lease)
```

- **queued**: turn triggered, waiting for a worker
- **pending**: worker polled and received it, hasn't acked yet
- **active**: worker acked, executing. Heartbeat required every 30s or lease expires
- **completed**: worker finished successfully
- **failed**: worker reported error or lease expired without heartbeat

### Work item shape

```json
{
  "type": "work",
  "id": "work_01abc...",
  "environment_id": "env_...",
  "state": "queued",
  "data": {
    "type": "session",
    "id": "sesn_..."
  },
  "metadata": {},
  "created_at": "...",
  "acknowledged_at": null,
  "started_at": null,
  "latest_heartbeat_at": null,
  "stop_requested_at": null,
  "stopped_at": null
}
```

## Worker CLI

```bash
# Start a worker that polls a specific environment
gateway worker --environment env_01abc --provider docker

# Poll all self_hosted environments
gateway worker --all --provider sprites

# Multiple workers on different machines
# Machine A:
gateway worker --remote https://gateway.internal:4000 --environment env_01abc --provider docker

# Machine B:
gateway worker --remote https://gateway.internal:4000 --environment env_01abc --provider mvm
```

The worker:
1. Polls `GET /v1/environments/:id/work/poll` (long poll, 30s timeout)
2. Receives a work item with session ID
3. Acks it: `POST /v1/environments/:id/work/:workId/ack`
4. Acquires a container from its configured provider
5. Executes the turn (same `enqueueTurn()` logic as today)
6. Heartbeats every 30s: `POST /v1/environments/:id/work/:workId/heartbeat`
7. On completion, events are written to the DB via the API
8. Polls for next work item

## Schema

```sql
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  worker_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  started_at INTEGER,
  latest_heartbeat_at INTEGER,
  stop_requested_at INTEGER,
  stopped_at INTEGER,
  lease_expires_at INTEGER,
  FOREIGN KEY (environment_id) REFERENCES environments(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_work_env_state ON work_items(environment_id, state);
CREATE INDEX idx_work_session ON work_items(session_id);
```

## Integration with existing turn driver

The change is in `enqueueTurn()` in `driver.ts`:

```typescript
// Before executing:
const env = getEnvironment(session.environment_id);
if (env?.config?.type === "self_hosted") {
  // Queue the work instead of executing
  createWorkItem({ environmentId: env.id, sessionId });
  return; // Worker will pick it up
}
// else: execute directly (current behavior)
```

The worker uses the same `runTurn()` function — it just runs on a different process/machine.

## What this unlocks

1. **Horizontal scaling** — N workers per environment, each on different machines
2. **Provider per worker** — API server doesn't need docker/sprites. Workers bring their own provider.
3. **Auto-scaling** — monitor `GET /work/stats` queue depth, scale workers up/down
4. **Mixed deployments** — some environments are `cloud` (inline), others are `self_hosted` (queued)
5. **Anthropic spec compatibility** — same 8 endpoints, same work item shape

## What doesn't change

- `cloud` environments work exactly as today (default)
- Single-process deployments don't need workers
- All existing features (skills, memory, outcomes, threads) work the same — they're session-level, not execution-level

## Delivery

| Task | Effort |
|---|---|
| Schema + work item CRUD | 1 day |
| 8 work queue endpoints | 1 day |
| Driver integration (queue instead of execute for self_hosted) | 1 day |
| `gateway worker` CLI command | 1 day |
| Worker turn execution loop | 2 days |
| Lease expiry + dead worker recovery | 1 day |
| Tests | 1 day |

~8 days total.
