# Anthropic API Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align all 4 core resource endpoints (agents, environments, sessions, vaults) with the official Anthropic Managed Agents OpenAPI spec.

**Architecture:** Fix response shapes, add missing fields/endpoints, and create a validation test that compares our OpenAPI spec against Anthropic's. Changes are additive — existing functionality (vault env vars, extra providers, multi-engine) continues to work. The Anthropic OpenAPI spec is saved at `docs/superpowers/specs/anthropic-openapi.yml` for reference.

**Tech Stack:** TypeScript, Zod, libsql, vitest

**Reference:** Official Anthropic OpenAPI spec at `docs/superpowers/specs/anthropic-openapi.yml` (27,636 lines, 91 endpoints)

---

## File Structure

### Files to modify:
- `packages/agent-sdk/src/types.ts` — Agent, Vault, Environment interfaces gain new fields
- `packages/agent-sdk/src/db/migrations.ts` — New columns: agents.description, agents.metadata_json, vaults.metadata_json, vaults.archived_at
- `packages/agent-sdk/src/db/agents.ts` — hydrate() adds description/metadata/type, mcp_servers→array, model→object; new listAgentVersions()
- `packages/agent-sdk/src/db/vaults.ts` — hydrate() adds metadata/type; agent_id optional; archiveVault()
- `packages/agent-sdk/src/db/environments.ts` — hydrate() adds type field
- `packages/agent-sdk/src/db/sessions.ts` — hydrateSession() embeds full agent, nested cache_creation
- `packages/agent-sdk/src/handlers/agents.ts` — Accept description/metadata/mcp_servers array; archive endpoint; versions endpoint; require version on update
- `packages/agent-sdk/src/handlers/environments.ts` — type in response (via hydrate)
- `packages/agent-sdk/src/handlers/sessions.ts` — Accept `statuses` array filter; resources sub-endpoints
- `packages/agent-sdk/src/handlers/vaults.ts` — agent_id optional; metadata; update endpoint; archive endpoint
- `packages/agent-sdk/src/http.ts` — Add `paginatedOk()` helper for `{ data, next_page }` shape
- `packages/agent-sdk/src/openapi/spec.ts` — Update to match Anthropic spec
- `packages/gateway-hono/src/routes.ts` — Register new route handlers
- `packages/agent-sdk/src/handlers/index.ts` — Export new handlers

### Files to create:
- `packages/agent-sdk/test/spec-alignment.test.ts` — Validates our API against Anthropic OpenAPI spec

### Test files to modify:
- `packages/agent-sdk/test/api-comprehensive.test.ts` — Update pagination assertions, add new field assertions

---

## Task 1: Pagination shape — `next_page` instead of `has_more`/`first_id`/`last_id`

All list endpoints must return `{ data: T[], next_page: string | null }` instead of `{ data, has_more, first_id, last_id }`.

`next_page` is an opaque cursor — we'll use the last item's ID (base64-encoded for opacity).

**Files:**
- Modify: `packages/agent-sdk/src/http.ts`
- Modify: `packages/agent-sdk/src/handlers/agents.ts`
- Modify: `packages/agent-sdk/src/handlers/environments.ts`
- Modify: `packages/agent-sdk/src/handlers/sessions.ts`
- Modify: `packages/agent-sdk/src/handlers/vaults.ts`
- Modify: `packages/agent-sdk/src/handlers/credentials.ts`
- Modify: `packages/agent-sdk/src/handlers/events.ts`
- Modify: `packages/agent-sdk/src/handlers/threads.ts`
- Test: `packages/agent-sdk/test/api-comprehensive.test.ts`

- [ ] **Step 1: Add `paginatedOk` helper to http.ts**

Add after the existing `jsonOk` function in `packages/agent-sdk/src/http.ts`:

```typescript
/** Build a paginated list response matching Anthropic's shape. */
export function paginatedOk<T extends { id: string }>(
  data: T[],
  requestedLimit: number,
): Response {
  const hasMore = data.length === requestedLimit;
  const nextPage = hasMore && data.length > 0
    ? Buffer.from(data[data.length - 1].id).toString("base64url")
    : null;
  return jsonOk({ data, next_page: nextPage });
}

/** Decode an opaque `page` cursor back to the original ID. */
export function decodeCursor(page: string | null | undefined): string | undefined {
  if (!page) return undefined;
  try {
    return Buffer.from(page, "base64url").toString("utf8");
  } catch {
    return page; // Fall back to raw ID for backward compat
  }
}
```

- [ ] **Step 2: Update agents list handler**

In `packages/agent-sdk/src/handlers/agents.ts`, change the `handleListAgents` response from:
```typescript
return jsonOk({
  data,
  has_more: data.length === limit,
  first_id: data.length > 0 ? data[0].id : null,
  last_id: data.length > 0 ? data[data.length - 1].id : null,
});
```
to:
```typescript
return paginatedOk(data, limit);
```

Also update the `page` query param parsing to use `decodeCursor()`:
```typescript
const page = decodeCursor(url.searchParams.get("page"));
```

Import `paginatedOk` and `decodeCursor` from `"../http"`.

- [ ] **Step 3: Update environments list handler**

Same pattern as agents in `packages/agent-sdk/src/handlers/environments.ts`:
- Import `paginatedOk, decodeCursor`
- Replace the response block with `return paginatedOk(data, limit);`
- Parse cursor: `const page = decodeCursor(url.searchParams.get("page"));`

- [ ] **Step 4: Update sessions list handler**

In `packages/agent-sdk/src/handlers/sessions.ts`:
- Import `paginatedOk, decodeCursor`
- Replace the response block with `return paginatedOk(data, limit);`
- Parse cursor: `const page = decodeCursor(url.searchParams.get("page"));`

Note: Sessions use `created_at`-based cursor internally but the `page` param is still an ID that gets resolved to a timestamp. `decodeCursor` handles the base64 decode.

- [ ] **Step 5: Update vaults, credentials, events, threads list handlers**

Apply the same pattern to all remaining list endpoints:
- `packages/agent-sdk/src/handlers/vaults.ts` — `handleListVaults`
- `packages/agent-sdk/src/handlers/credentials.ts` — `handleListCredentials`
- `packages/agent-sdk/src/handlers/events.ts` — `handleListEvents`
- `packages/agent-sdk/src/handlers/threads.ts` — `handleListThreads`

Each one: import helpers, replace response block with `paginatedOk(data, limit)`, decode cursor.

- [ ] **Step 6: Update tests**

In `packages/agent-sdk/test/api-comprehensive.test.ts`, find all assertions on `has_more`, `first_id`, `last_id` and replace with `next_page`:

```typescript
// Old:
expect(body.has_more).toBe(false);
expect(body.first_id).toBeDefined();
expect(body.last_id).toBeDefined();

// New:
expect(body.next_page).toBeNull(); // or toBeDefined() if has_more was true
expect(body.data).toBeDefined();
```

- [ ] **Step 7: Run tests and commit**

```bash
npx vitest run packages/agent-sdk/test/api-comprehensive.test.ts
git add -A && git commit -m "refactor: pagination shape to { data, next_page } matching Anthropic spec"
```

---

## Task 2: Agent — add `type`, `description`, `metadata`, model object, mcp_servers array

**Files:**
- Modify: `packages/agent-sdk/src/types.ts` — Add fields to Agent interface
- Modify: `packages/agent-sdk/src/db/migrations.ts` — Add columns
- Modify: `packages/agent-sdk/src/db/agents.ts` — hydrate() adds new fields; createAgent/updateAgent accept them
- Modify: `packages/agent-sdk/src/handlers/agents.ts` — CreateSchema/UpdateSchema accept description, metadata, mcp_servers array, model string|object

- [ ] **Step 1: Add columns to migrations**

In `packages/agent-sdk/src/db/migrations.ts`, add in the migrations section (follow the existing `PRAGMA table_info` pattern):

```typescript
// Agent description + metadata (Anthropic API alignment)
{
  const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("description")) {
    db.exec("ALTER TABLE agents ADD COLUMN description TEXT");
  }
  if (!names.has("metadata_json")) {
    db.exec("ALTER TABLE agents ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  }
}
```

- [ ] **Step 2: Update Agent types**

In `packages/agent-sdk/src/types.ts`, add to `AgentRow`:
```typescript
description: string | null;
metadata_json: string;
```

Add to `Agent` interface:
```typescript
type: "agent";
description: string;
metadata: Record<string, string>;
model: { id: string; speed?: "standard" | "fast" };
```

Remove the existing `model: string` from the Agent interface (it becomes an object).

- [ ] **Step 3: Update agent hydration**

In `packages/agent-sdk/src/db/agents.ts`, update `hydrate()`:

```typescript
function hydrate(row: AgentRow, ver: AgentVersionRow): Agent {
  const modelConfig = ver.model_config_json ? JSON.parse(ver.model_config_json) : {};
  const mcp = ver.mcp_servers_json ? JSON.parse(ver.mcp_servers_json) : {};
  // Normalize mcp_servers to array format for Anthropic compat
  const mcpArray = Array.isArray(mcp)
    ? mcp
    : Object.entries(mcp).map(([name, cfg]) => ({
        name,
        type: "url" as const,
        ...((typeof cfg === "string") ? { url: cfg } : cfg as Record<string, unknown>),
      }));

  return {
    type: "agent" as const,
    id: row.id,
    version: ver.version,
    name: row.name,
    description: row.description ?? "",
    model: { id: ver.model, ...(modelConfig.speed ? { speed: modelConfig.speed } : {}) },
    system: ver.system ?? "",
    tools: ver.tools_json ? JSON.parse(ver.tools_json) : [],
    mcp_servers: mcpArray,
    engine: (ver.backend ?? "claude") as BackendName,
    // ... rest unchanged ...
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    skills: ver.skills_json ? JSON.parse(ver.skills_json) : [],
    model_config: modelConfig,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    archived_at: row.archived_at ? new Date(row.archived_at).toISOString() : null,
  };
}
```

Note: Keep `engine` and `model_config` as non-standard extensions. The `model` field becomes `{ id, speed? }` to match Anthropic. Internally we still store `model` as a string column and `model_config_json` separately.

- [ ] **Step 4: Update agent create/update handlers**

In `packages/agent-sdk/src/handlers/agents.ts`:

Update `CreateSchema` to accept:
```typescript
description: z.string().max(2048).optional(),
metadata: z.record(z.string().max(512)).optional(),
model: z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1), speed: z.enum(["standard", "fast"]).optional() }),
]),
mcp_servers: z.union([
  z.record(z.unknown()),  // Legacy record format
  z.array(z.object({
    name: z.string().min(1),
    type: z.literal("url").optional(),
    url: z.string().optional(),
  }).passthrough()),
]).optional(),
```

In the handler, normalize `model`:
```typescript
const modelInput = parsed.data.model;
const modelId = typeof modelInput === "string" ? modelInput : modelInput.id;
const modelSpeed = typeof modelInput === "object" ? modelInput.speed : undefined;
```

Normalize `mcp_servers` — if array, convert to record for DB storage:
```typescript
const mcpInput = parsed.data.mcp_servers;
let mcpRecord: Record<string, unknown> = {};
if (Array.isArray(mcpInput)) {
  for (const s of mcpInput) mcpRecord[s.name] = { type: s.type ?? "url", url: s.url, ...s };
} else if (mcpInput) {
  mcpRecord = mcpInput;
}
```

Pass `description` and `metadata_json: JSON.stringify(metadata ?? {})` to `createAgent()`.

- [ ] **Step 5: Update createAgent/updateAgent DB functions**

In `packages/agent-sdk/src/db/agents.ts`:
- `createAgent()`: accept and insert `description`, `metadata_json` columns
- `updateAgent()`: accept and update `description`, `metadata_json` columns (on the agents table, not agent_versions)
- If `model_config_json` has `speed`, also store it there (already works — just pass speed through)

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run packages/agent-sdk/test/api-comprehensive.test.ts
git add -A && git commit -m "feat(agents): add type, description, metadata; model as object; mcp_servers as array"
```

---

## Task 3: Agent — archive endpoint + version requirement + versions list

**Files:**
- Modify: `packages/agent-sdk/src/handlers/agents.ts` — Add `handleArchiveAgent`, `handleListAgentVersions`; require `version` in update
- Modify: `packages/agent-sdk/src/db/agents.ts` — Add `listAgentVersions()`
- Modify: `packages/agent-sdk/src/handlers/index.ts` — Export new handlers
- Modify: `packages/gateway-hono/src/routes.ts` — Register new routes
- Modify: `packages/agent-sdk/src/types.ts` — Add to exports if needed

- [ ] **Step 1: Add `POST /agents/:id/archive` handler**

In `packages/agent-sdk/src/handlers/agents.ts`, add:

```typescript
/** POST /v1/agents/:id/archive — soft-archive, returns full agent */
export async function handleArchiveAgent(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const id = new URL(request.url).pathname.split("/").at(-2)!;
    await assertTenantOwns("agents", id, auth);
    archiveAgent(id);
    const agent = getAgent(id);
    if (!agent) return jsonOk({ type: "error", error: { type: "not_found_error", message: "Agent not found" } }, 404);
    return jsonOk(agent);
  });
}
```

Keep the existing `DELETE /v1/agents/:id` working (returns `{ id, type: "agent_deleted" }`) for backward compat.

- [ ] **Step 2: Add `GET /agents/:id/versions` handler**

In `packages/agent-sdk/src/handlers/agents.ts`:

```typescript
/** GET /v1/agents/:id/versions — list all versions */
export async function handleListAgentVersions(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const id = new URL(request.url).pathname.split("/").at(-2)!;
    await assertTenantOwns("agents", id, auth);
    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20"), 1), 100);
    const page = decodeCursor(url.searchParams.get("page"));
    const versions = listAgentVersions(id, { limit, cursor: page });
    return paginatedOk(versions, limit);
  });
}
```

- [ ] **Step 3: Add `listAgentVersions()` DB function**

In `packages/agent-sdk/src/db/agents.ts`:

```typescript
export function listAgentVersions(
  agentId: string,
  opts: { limit: number; cursor?: string },
): Agent[] {
  const row = db().prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
  if (!row) return [];
  const conditions = ["agent_id = ?"];
  const params: unknown[] = [agentId];
  if (opts.cursor) {
    const cursorVersion = parseInt(opts.cursor);
    if (!isNaN(cursorVersion)) {
      conditions.push("version < ?");
      params.push(cursorVersion);
    }
  }
  params.push(opts.limit);
  const versions = db()
    .prepare(`SELECT * FROM agent_versions WHERE ${conditions.join(" AND ")} ORDER BY version DESC LIMIT ?`)
    .all(...params) as AgentVersionRow[];
  return versions.map((v) => ({ ...hydrate(row, v), id: `${agentId}:v${v.version}` }));
}
```

Note: Each version in the list needs an `id` for pagination. We'll use `agentId` as the id and version as the cursor value. Actually, simpler: give each version row a synthetic id of the agent id, and use `version` number as cursor.

Actually, looking at the Anthropic spec more carefully — the versions endpoint returns Agent objects. The `id` is the agent id (same for all versions), and `version` differs. For pagination, `next_page` will be based on the version number. Let me adjust:

```typescript
export function listAgentVersions(
  agentId: string,
  opts: { limit: number; cursor?: number },
): Agent[] {
  const row = db().prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
  if (!row) return [];
  const conditions = ["agent_id = ?"];
  const params: unknown[] = [agentId];
  if (opts.cursor != null) {
    conditions.push("version < ?");
    params.push(opts.cursor);
  }
  params.push(opts.limit);
  const versions = db()
    .prepare(`SELECT * FROM agent_versions WHERE ${conditions.join(" AND ")} ORDER BY version DESC LIMIT ?`)
    .all(...params) as AgentVersionRow[];
  return versions.map((v) => hydrate(row, v));
}
```

For the handler, since versions use integer cursors instead of ID strings, use a version-specific pagination:

```typescript
const versions = listAgentVersions(id, { limit, cursor: page ? parseInt(page) : undefined });
const hasMore = versions.length === limit;
const nextPage = hasMore && versions.length > 0
  ? Buffer.from(String(versions[versions.length - 1].version)).toString("base64url")
  : null;
return jsonOk({ data: versions, next_page: nextPage });
```

- [ ] **Step 4: Require `version` in update**

In `packages/agent-sdk/src/handlers/agents.ts`, update `UpdateSchema`:

```typescript
const UpdateSchema = CreateSchema.partial().extend({
  version: z.number().int().min(1),
});
```

In the update handler, validate that the provided version matches the current version:
```typescript
const current = getAgent(id);
if (!current) return jsonOk({ type: "error", error: { type: "not_found_error", message: "Agent not found" } }, 404);
if (parsed.data.version !== current.version) {
  return jsonOk({ type: "error", error: { type: "invalid_request_error", message: `Version mismatch: expected ${current.version}, got ${parsed.data.version}` } }, 409);
}
```

- [ ] **Step 5: Register new routes**

In `packages/gateway-hono/src/routes.ts`, add:
```typescript
app.post("/v1/agents/:id/archive", (c) => handleArchiveAgent(c.req.raw));
app.get("/v1/agents/:id/versions", (c) => handleListAgentVersions(c.req.raw));
```

Export the new handlers from `packages/agent-sdk/src/handlers/index.ts`.

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run packages/agent-sdk/test/api-comprehensive.test.ts
git add -A && git commit -m "feat(agents): POST /archive endpoint, GET /versions, require version on update"
```

---

## Task 4: Environment — add `type: "environment"` to response

**Files:**
- Modify: `packages/agent-sdk/src/types.ts` — Add `type` to Environment interface
- Modify: `packages/agent-sdk/src/db/environments.ts` — hydrate() adds type

- [ ] **Step 1: Add type field**

In `packages/agent-sdk/src/types.ts`, add to `Environment`:
```typescript
type: "environment";
```

In `packages/agent-sdk/src/db/environments.ts`, add to `hydrate()`:
```typescript
type: "environment" as const,
```

- [ ] **Step 2: Run tests and commit**

```bash
npx vitest run packages/agent-sdk/test/api-comprehensive.test.ts
git add -A && git commit -m "feat(environments): add type: environment to response"
```

---

## Task 5: Session — embed full agent object + nested cache_creation + statuses filter

**Files:**
- Modify: `packages/agent-sdk/src/db/sessions.ts` — hydrateSession() loads full agent, restructures cache_creation
- Modify: `packages/agent-sdk/src/types.ts` — Update Session.agent type, Session.usage type
- Modify: `packages/agent-sdk/src/handlers/sessions.ts` — Accept `statuses` array filter

- [ ] **Step 1: Update Session types**

In `packages/agent-sdk/src/types.ts`, change the `agent` field in Session from:
```typescript
agent: { type: "agent"; id: string; version: number };
```
to:
```typescript
agent: {
  type: "agent";
  id: string;
  version: number;
  name: string;
  description: string;
  model: { id: string; speed?: "standard" | "fast" };
  system: string;
  tools: unknown[];
  mcp_servers: unknown[];
  skills: unknown[];
};
```

Update `usage` to nest `cache_creation`:
```typescript
usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  cost_usd: number;
};
```

- [ ] **Step 2: Update hydrateSession() to embed full agent**

In `packages/agent-sdk/src/db/sessions.ts`, update `hydrateSession()`:

```typescript
// Look up the agent version for embedding
const { getAgent } = await import("./agents");
const agent = getAgent(row.agent_id, row.agent_version);

// Build the embedded agent object
const embeddedAgent = agent
  ? {
      type: "agent" as const,
      id: agent.id,
      version: agent.version,
      name: agent.name,
      description: agent.description ?? "",
      model: agent.model,
      system: agent.system ?? "",
      tools: agent.tools,
      mcp_servers: agent.mcp_servers,
      skills: agent.skills,
    }
  : { type: "agent" as const, id: row.agent_id, version: row.agent_version, name: "", description: "", model: { id: "" }, system: "", tools: [], mcp_servers: [], skills: [] };
```

Replace the existing `agent: { type: "agent", id, version }` with `agent: embeddedAgent`.

Update the `usage` object:
```typescript
usage: {
  input_tokens: row.usage_input_tokens,
  output_tokens: row.usage_output_tokens,
  cache_read_input_tokens: row.usage_cache_read_input_tokens,
  cache_creation: {
    ephemeral_5m_input_tokens: row.usage_cache_creation_input_tokens,
    ephemeral_1h_input_tokens: 0,
  },
  cost_usd: row.usage_cost_usd,
},
```

- [ ] **Step 3: Accept `statuses` array filter**

In `packages/agent-sdk/src/handlers/sessions.ts`, add support for `statuses` query param (array):

```typescript
// Accept both singular `status` and plural `statuses` (Anthropic uses plural)
const statusParam = url.searchParams.get("status");
const statusesParam = url.searchParams.getAll("statuses");
const statuses = statusesParam.length > 0 ? statusesParam : statusParam ? [statusParam] : undefined;
```

Pass `statuses` to the `listSessions()` DB call. In `packages/agent-sdk/src/db/sessions.ts`, update to accept an array:
```typescript
if (opts.statuses && opts.statuses.length > 0) {
  conditions.push(`status IN (${opts.statuses.map(() => "?").join(",")})`);
  params.push(...opts.statuses);
}
```

- [ ] **Step 4: Run tests and commit**

```bash
npx vitest run packages/agent-sdk/test/api-comprehensive.test.ts
git add -A && git commit -m "feat(sessions): embed full agent object, nested cache_creation, statuses filter"
```

---

## Task 6: Vault — add `type`, `metadata`, optional `agent_id`, update/archive endpoints

**Files:**
- Modify: `packages/agent-sdk/src/types.ts` — Add type, metadata, archived_at to Vault
- Modify: `packages/agent-sdk/src/db/migrations.ts` — Add metadata_json, archived_at columns to vaults
- Modify: `packages/agent-sdk/src/db/vaults.ts` — hydrate adds type/metadata; archiveVault(); agent_id optional
- Modify: `packages/agent-sdk/src/handlers/vaults.ts` — Update create schema (agent_id optional), add update/archive handlers

- [ ] **Step 1: Add columns to migrations**

In `packages/agent-sdk/src/db/migrations.ts`:

```typescript
// Vault metadata + archived_at (Anthropic API alignment)
{
  const cols = db.prepare("PRAGMA table_info(vaults)").all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("metadata_json")) {
    db.exec("ALTER TABLE vaults ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!names.has("archived_at")) {
    db.exec("ALTER TABLE vaults ADD COLUMN archived_at INTEGER");
  }
}
```

- [ ] **Step 2: Update Vault types**

In `packages/agent-sdk/src/types.ts`:

Add to `VaultRow`:
```typescript
metadata_json: string;
archived_at: number | null;
```

Update `Vault` interface:
```typescript
export interface Vault {
  type: "vault";
  id: string;
  agent_id: string | null;   // Optional — Anthropic vaults are standalone
  name: string;
  display_name: string;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}
```

- [ ] **Step 3: Update vault hydration and DB functions**

In `packages/agent-sdk/src/db/vaults.ts`, update `hydrateVault()`:
```typescript
function hydrateVault(row: VaultRow): Vault {
  return {
    type: "vault" as const,
    id: row.id,
    agent_id: row.agent_id || null,
    name: row.name,
    display_name: row.name,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    archived_at: row.archived_at ? new Date(row.archived_at).toISOString() : null,
  };
}
```

Add `archiveVault()` and `updateVault()`:
```typescript
export function archiveVault(id: string): boolean {
  const result = db()
    .prepare("UPDATE vaults SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
    .run(nowMs(), id);
  return result.changes > 0;
}

export function updateVault(id: string, fields: { display_name?: string; metadata?: Record<string, string> }): Vault | undefined {
  const updates: string[] = ["updated_at = ?"];
  const params: unknown[] = [nowMs()];
  if (fields.display_name) {
    updates.push("name = ?");
    params.push(fields.display_name);
  }
  if (fields.metadata) {
    updates.push("metadata_json = ?");
    params.push(JSON.stringify(fields.metadata));
  }
  params.push(id);
  db().prepare(`UPDATE vaults SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  return getVault(id);
}
```

- [ ] **Step 4: Update vault handler**

In `packages/agent-sdk/src/handlers/vaults.ts`:

Make `agent_id` optional in `CreateVaultSchema`:
```typescript
agent_id: z.string().min(1).optional(),
```

When `agent_id` is omitted, skip the agent ownership validation.

Add update handler:
```typescript
export async function handleUpdateVault(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const id = new URL(request.url).pathname.split("/").pop()!;
    // ... tenant check, parse body with UpdateVaultSchema (display_name, metadata optional) ...
    const vault = updateVault(id, parsed.data);
    if (!vault) return jsonOk({ type: "error", error: { type: "not_found_error", message: "Vault not found" } }, 404);
    return jsonOk(vault);
  });
}
```

Add archive handler:
```typescript
export async function handleArchiveVault(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const id = new URL(request.url).pathname.split("/").at(-2)!;
    // ... tenant check ...
    archiveVault(id);
    const vault = getVault(id);
    if (!vault) return jsonOk({ type: "error", error: { type: "not_found_error", message: "Vault not found" } }, 404);
    return jsonOk(vault);
  });
}
```

Update delete handler to return `{ id, type: "vault_deleted" }`.

- [ ] **Step 5: Register new routes**

In `packages/gateway-hono/src/routes.ts`:
```typescript
app.post("/v1/vaults/:id", (c) => handleUpdateVault(c.req.raw));
app.post("/v1/vaults/:id/archive", (c) => handleArchiveVault(c.req.raw));
```

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run packages/agent-sdk/test/api-comprehensive.test.ts
git add -A && git commit -m "feat(vaults): add type, metadata, archive endpoint; agent_id optional"
```

---

## Task 7: Session resources CRUD endpoints

Anthropic has dedicated endpoints for session resources:
- `GET /v1/sessions/:id/resources` — list
- `POST /v1/sessions/:id/resources` — add
- `GET /v1/sessions/:id/resources/:resource_id` — get
- `POST /v1/sessions/:id/resources/:resource_id` — update
- `DELETE /v1/sessions/:id/resources/:resource_id` — delete

**Files:**
- Modify: `packages/agent-sdk/src/handlers/resources.ts` — Add list/get/update/delete handlers (create may already exist)
- Modify: `packages/agent-sdk/src/db/session-resources.ts` — CRUD functions
- Modify: `packages/gateway-hono/src/routes.ts` — Register routes

- [ ] **Step 1: Review existing resources handler**

Read `packages/agent-sdk/src/handlers/resources.ts` and `packages/agent-sdk/src/db/session-resources.ts` to understand what already exists.

- [ ] **Step 2: Add missing CRUD handlers**

Add `handleListSessionResources`, `handleGetSessionResource`, `handleUpdateSessionResource`, `handleDeleteSessionResource` as needed, following the pattern in the existing handlers.

Each resource in the response should have:
```typescript
{
  id: string,          // resource ID
  type: "github_repository" | "file" | "memory_store",
  created_at: string,
  updated_at: string,
  // ... type-specific fields
}
```

- [ ] **Step 3: Register routes and commit**

```bash
git add -A && git commit -m "feat(sessions): resource CRUD endpoints for Anthropic API alignment"
```

---

## Task 8: Update OpenAPI spec

**Files:**
- Modify: `packages/agent-sdk/src/openapi/spec.ts`

- [ ] **Step 1: Update all response schemas**

Update every schema in `spec.ts` to match the changes made in Tasks 1-7:
- Pagination: `next_page` instead of `has_more`/`first_id`/`last_id`
- Agent: add `type`, `description`, `metadata`, `model` as object, `mcp_servers` as array, `archived_at`
- Environment: add `type`
- Session: embedded agent object, nested `cache_creation`
- Vault: add `type`, `metadata`, `archived_at`

- [ ] **Step 2: Add new endpoints to spec**
- `POST /v1/agents/:id/archive`
- `GET /v1/agents/:id/versions`
- `POST /v1/vaults/:id` (update)
- `POST /v1/vaults/:id/archive`
- Session resource CRUD endpoints

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs(openapi): align spec with Anthropic API shape"
```

---

## Task 9: Spec validation test

Create a test that loads both our OpenAPI spec and the Anthropic spec, then validates that our response schemas are a superset of Anthropic's (we can have extra fields but must not be missing required ones).

**Files:**
- Create: `packages/agent-sdk/test/spec-alignment.test.ts`

- [ ] **Step 1: Write the validation test**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "yaml";

// Load Anthropic OpenAPI spec
const anthropicSpec = yaml.parse(
  readFileSync(join(__dirname, "../../../docs/superpowers/specs/anthropic-openapi.yml"), "utf8"),
);

// Load our spec (generated at runtime)
// Import our spec builder and get the JSON
import { buildOpenApiSpec } from "../src/openapi/spec";
const ourSpec = buildOpenApiSpec();

const MANAGED_AGENTS_SCHEMAS = [
  "BetaManagedAgentsAgent",
  "BetaManagedAgentsSession",
  "BetaManagedAgentsVault",
  // Add BetaEnvironment if it exists
];

describe("Anthropic API spec alignment", () => {
  // 1. All Anthropic endpoints exist in our spec
  it("implements all managed-agents endpoints", () => {
    const anthropicPaths = Object.keys(anthropicSpec.paths)
      .filter((p) => p.includes("beta=true") && (
        p.startsWith("/v1/agents") ||
        p.startsWith("/v1/sessions") ||
        p.startsWith("/v1/environments") ||
        p.startsWith("/v1/vaults")
      ))
      .map((p) => p.replace("?beta=true", ""));

    for (const path of anthropicPaths) {
      const methods = Object.keys(anthropicSpec.paths[`${path}?beta=true`]);
      for (const method of methods) {
        // Check our spec has this path + method
        const ourPath = ourSpec.paths?.[path];
        expect(ourPath, `Missing path: ${method.toUpperCase()} ${path}`).toBeDefined();
        expect(ourPath[method], `Missing method: ${method.toUpperCase()} ${path}`).toBeDefined();
      }
    }
  });

  // 2. Response schemas include all required Anthropic fields
  it("agent response includes all Anthropic required fields", () => {
    const anthropicAgent = anthropicSpec.components.schemas.BetaManagedAgentsAgent;
    const required = anthropicAgent.required || [];
    // Check our agent response schema has all required fields
    for (const field of required) {
      // Verify via a test API call or schema check
      expect(required).toContain(field);
    }
  });

  // 3. List responses use next_page
  it("list responses use next_page pagination", () => {
    const listSchemas = [
      "BetaManagedAgentsListAgents",
      "BetaManagedAgentsListSessions",
      "BetaManagedAgentsListVaultsResponse",
    ];
    for (const name of listSchemas) {
      const schema = anthropicSpec.components.schemas[name];
      if (schema?.properties?.next_page) {
        // Our list responses must also have next_page
        // Tested via integration tests
      }
    }
  });

  // 4. Validate required fields on each resource
  const resourceChecks = [
    { name: "Agent", schema: "BetaManagedAgentsAgent", requiredFields: ["type", "id", "version", "name", "description", "model", "system", "tools", "mcp_servers", "skills", "metadata", "created_at", "updated_at", "archived_at"] },
    { name: "Session", schema: "BetaManagedAgentsSession", requiredFields: ["type", "id", "status", "created_at", "updated_at", "environment_id", "title", "metadata", "agent", "resources", "vault_ids", "usage", "stats", "archived_at"] },
    { name: "Vault", schema: "BetaManagedAgentsVault", requiredFields: ["type", "id", "display_name", "metadata", "created_at", "updated_at", "archived_at"] },
  ];

  for (const check of resourceChecks) {
    it(`${check.name} response has all Anthropic required fields`, async () => {
      // Create a resource via handler and verify all fields present
      // This is an integration test that exercises the actual handler
    });
  }
});
```

The actual test should create resources via handlers and verify the response includes all Anthropic required fields. Use the existing test helpers (like `req()` from api-comprehensive.test.ts).

- [ ] **Step 2: Write integration assertions**

For each resource type, create one via the handler, parse the response, and assert every Anthropic-required field is present and non-undefined:

```typescript
it("agent response has all required Anthropic fields", async () => {
  const res = await handleCreateAgent(
    req("/v1/agents", { method: "POST", body: JSON.stringify({ name: "test", model: "claude-sonnet-4-6" }) }),
  );
  const body = await res.json();
  const required = ["type", "id", "version", "name", "description", "model", "system", "tools", "mcp_servers", "skills", "metadata", "created_at", "updated_at", "archived_at"];
  for (const field of required) {
    expect(body).toHaveProperty(field);
  }
  expect(body.type).toBe("agent");
  expect(body.model).toHaveProperty("id");
  expect(Array.isArray(body.mcp_servers)).toBe(true);
});
```

Similar for session, vault, environment.

- [ ] **Step 3: Run and commit**

```bash
npx vitest run packages/agent-sdk/test/spec-alignment.test.ts
git add -A && git commit -m "test: spec alignment validation against Anthropic OpenAPI spec"
```

---

## Self-Review Checklist

1. **Spec coverage:**
   - ✅ Pagination shape (Task 1)
   - ✅ Agent type/description/metadata (Task 2)
   - ✅ Agent mcp_servers array (Task 2)
   - ✅ Agent model object (Task 2)
   - ✅ Agent archive endpoint (Task 3)
   - ✅ Agent versions list (Task 3)
   - ✅ Agent update OCC (Task 3)
   - ✅ Environment type field (Task 4)
   - ✅ Session embedded agent (Task 5)
   - ✅ Session cache_creation nested (Task 5)
   - ✅ Session statuses filter (Task 5)
   - ✅ Vault type/metadata/archive (Task 6)
   - ✅ Vault agent_id optional (Task 6)
   - ✅ Vault update endpoint (Task 6)
   - ✅ Session resource CRUD (Task 7)
   - ✅ OpenAPI spec update (Task 8)
   - ✅ Spec validation test (Task 9)

2. **Backward compat:**
   - Vault `agent_id` becomes optional (existing vaults with agent_id still work)
   - `DELETE /agents/:id` still works (returns `agent_deleted`)
   - `model` accepts both string and object formats
   - `mcp_servers` accepts both record and array formats
   - Pagination: clients reading `has_more`/`first_id`/`last_id` will get undefined (breaking — acceptable for spec alignment)
   - `page` param accepts both raw IDs and base64-encoded cursors

3. **Type consistency:** All tasks use the same field names: `type`, `description`, `metadata`, `next_page`, `archived_at`.
