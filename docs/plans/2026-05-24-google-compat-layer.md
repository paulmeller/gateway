# Google Interactions API Compatibility Layer

> Goal: Accept Google Gen AI SDK calls (`client.interactions.create()`, `client.agents.create()`)
> at `/google/v1beta/*`, translating to our existing Anthropic-compatible primitives.

## Google's Full API Surface (as of May 2026)

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1beta/interactions` | Create interaction (the main endpoint) |
| GET | `/v1beta/interactions/:id` | Retrieve / resume stream |
| DELETE | `/v1beta/interactions/:id` | Delete interaction |
| POST | `/v1beta/interactions/:id/cancel` | Cancel in-progress interaction |
| POST | `/v1beta/agents` | Create managed agent |
| GET | `/v1beta/agents` | List agents |
| GET | `/v1beta/agents/:id` | Get agent |
| DELETE | `/v1beta/agents/:id` | Delete agent |
| GET | `/v1beta/files/environment-:id:download` | Download environment tar |

### Create Interaction — Request Schema

```typescript
interface CreateInteractionRequest {
  // Model OR agent (one required)
  model?: string;                          // e.g. "gemini-3.5-flash"
  agent?: string;                          // e.g. "antigravity-preview-05-2026" or custom ID

  // Required
  input: string | Content[] | Step[];      // User message

  // Optional
  system_instruction?: string;
  tools?: Tool[];
  generation_config?: GenerationConfig;
  previous_interaction_id?: string;        // Multi-turn
  environment?: "remote" | string | EnvironmentConfig;
  stream?: boolean;
  background?: boolean;                    // Run async, poll later
  store?: boolean;                         // Persist interaction
  response_format?: ResponseFormat;
  response_mime_type?: string;
  response_modalities?: ("text"|"image"|"audio"|"video"|"document")[];
  service_tier?: "flex" | "standard" | "priority";
  webhook_config?: { uris: string[], user_metadata?: object };
  agent_config?: object;
}
```

### Create Interaction — Response Schema (Interaction resource)

```typescript
interface Interaction {
  id: string;
  model?: string;
  agent?: string;
  created: string;                         // ISO 8601
  updated: string;
  status: "in_progress" | "requires_action" | "completed" | "failed" |
          "cancelled" | "incomplete" | "budget_exceeded";
  steps: Step[];
  input?: Content[] | Step[] | string;
  usage: Usage;
  environment_id?: string;
  previous_interaction_id?: string;
  system_instruction?: string;
  tools?: Tool[];
  service_tier?: string;
  webhook_config?: object;
}
```

### Step Types

| Step type | Purpose |
|-----------|---------|
| `user_input` | User's input content |
| `model_output` | Model text response |
| `thought` | Reasoning (signature + optional summary) |
| `function_call` | Custom function tool call |
| `function_result` | Client-provided function result |
| `code_execution_call` | Code sandbox execution |
| `code_execution_result` | Code output / error |
| `google_search_call` | Web search invocation |
| `google_search_result` | Search results |
| `url_context_call` | URL fetch |
| `url_context_result` | Fetched page content |
| `mcp_server_tool_call` | MCP tool invocation |
| `mcp_server_tool_result` | MCP tool response |
| `file_search_call` | RAG file search |
| `file_search_result` | Search results |
| `google_maps_call` | Maps query |
| `google_maps_result` | Places/directions |

### Streaming Events (SSE)

| event_type | Payload |
|-----------|---------|
| `interaction.created` | Full interaction object |
| `step.start` | `{ index, step }` |
| `step.delta` | `{ index, delta: StepDeltaData }` |
| `step.stop` | `{ index }` |
| `interaction.status_update` | `{ interaction_id, status }` |
| `interaction.completed` | Final interaction (empty steps) |
| `error` | `{ error: { code, message } }` |

### Tool Types

| Tool type | Fields |
|-----------|--------|
| `function` | `name, description, parameters` (JSON Schema) |
| `code_execution` | (no config) |
| `url_context` | (no config) |
| `google_search` | `search_types[]` |
| `mcp_server` | `name, url, headers, allowed_tools` |
| `computer_use` | `environment` |
| `file_search` | `file_search_store_names, top_k` |
| `google_maps` | `latitude, longitude` |

### Generation Config

```typescript
interface GenerationConfig {
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stop_sequences?: string[];
  seed?: number;
  thinking_level?: "minimal" | "low" | "medium" | "high";
  thinking_summaries?: "auto" | "none";
  tool_choice?: ToolChoiceConfig;
}
```

### Environment Config

```typescript
interface EnvironmentConfig {
  type: "remote";
  sources?: Source[];
  network?: "unrestricted" | { allowlist: AllowlistItem[] };
}

interface Source {
  type: "inline" | "repository" | "gcs" | "skill_registry";
  source?: string;       // URL/path for repo/gcs
  target?: string;       // Mount path in container
  content?: string;      // For inline
  encoding?: string;     // e.g. "base64"
}

interface AllowlistItem {
  domain: string;
  transform?: Record<string, string>;  // Headers to inject
}
```

### Agent Management

```typescript
// POST /v1beta/agents
interface CreateAgentRequest {
  id: string;
  description?: string;
  base_agent: string;           // "antigravity-preview-05-2026"
  system_instruction?: string;
  tools?: Tool[];
  base_environment?: string | EnvironmentConfig;
}

// GET /v1beta/agents/:id response
interface Agent {
  id: string;
  description?: string;
  base_agent: string;
  system_instruction?: string;
  tools?: Tool[];
  base_environment?: string | EnvironmentConfig;
  created: string;
  updated: string;
}
```

### Usage

```typescript
interface Usage {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_thought_tokens: number;
  total_tool_use_tokens: number;
  total_tokens: number;
}
```

### Authentication

- Header: `x-goog-api-key: <GEMINI_API_KEY>`
- Header: `Api-Revision: 2026-05-20` (optional, for version pinning)

---

## Translation Mapping

### Route Prefix

**`/google/v1beta/*`** (not `/v1beta/` — avoids conflict with Google's own namespace)

### Auth

Middleware copies `x-goog-api-key` → `x-api-key` before hitting `routeWrap`. Core auth unchanged.

### `POST /google/v1beta/interactions` → Internal Flow

```
1. Resolve target:
   - If request.agent → look up agent by name
   - If request.model → find/create a default agent with that model + gemini engine

2. Resolve session:
   - If previous_interaction_id → look up google_interactions table → get session_id
   - Else → create session:
     - Create environment if environment="remote"
     - POST internal: handleCreateSession({ agent, environment_id, resources })

3. Inject sources (if environment has sources):
   - .agents/skills/*/SKILL.md → skill injection
   - .agents/AGENTS.md → prepend to system prompt
   - repository → session resource (github_repository)
   - inline (other paths) → session resource (file)

4. Send message:
   - POST internal: handleBatchEvents with user.message

5. Wait for completion (or stream):
   - Subscribe to SSE event bus
   - Collect events until session.status_idle or session.error
   - Map stop_reason:
     - end_turn → status: "completed"
     - error → status: "failed"  
     - custom_tool_call → status: "requires_action"
     - interrupted → status: "cancelled"

6. Build response:
   - Map agent.message → model_output steps
   - Map agent.tool_use → function_call steps
   - Map agent.tool_result → code_execution_result / function_result steps
   - Accumulate usage from span events

7. Store interaction mapping:
   - INSERT google_interactions (id: ulid, session_id, seq, created_at)

8. Return Interaction object
```

### `requires_action` handling (function calls)

When the session stops with `custom_tool_call`:
- Return status `requires_action` with the function_call step
- Client calls `POST /google/v1beta/interactions` again with:
  - `previous_interaction_id` = this interaction's ID
  - `input` = `[{ type: "function_result", call_id, result }]`
- Adapter posts `user.custom_tool_result` to the session

### Streaming (`stream: true`)

Return SSE stream that translates internal events:

| Internal event | Google SSE event |
|---------------|-----------------|
| (connection opened) | `interaction.created` |
| `agent.message` delta | `step.start` (type: model_output) + `step.delta` (text) |
| `agent.tool_use` | `step.start` (type: function_call) |
| `agent.tool_result` | `step.start` (type: code_execution_result) |
| `session.status_idle` | `interaction.status_update` + `interaction.completed` |
| `session.error` | `error` event |

### `GET /google/v1beta/interactions/:id`

- Look up `google_interactions` table → get session_id + seq
- If `stream: true` query param → reconnect to live SSE (long-poll)
- Else → return stored interaction state (events from DB)

### `POST /google/v1beta/interactions/:id/cancel`

- Look up session_id from interaction
- Post `user.interrupt` event to session
- Return interaction with status "cancelled"

### `POST /google/v1beta/agents`

```
1. Map base_agent → engine + model:
   - Configurable mapping (settings table), default:
     "antigravity-preview-05-2026" → engine: "gemini", model: "gemini-2.5-flash"

2. Extract skills from sources:
   - source.target matching .agents/skills/*/SKILL.md → skill
   - source.target matching .agents/AGENTS.md → append to system_instruction

3. Create internal agent:
   POST internal: handleCreateAgent({
     name: request.id,
     engine: mapped_engine,
     model: { id: mapped_model },
     system: system_instruction + AGENTS.md content,
     skills: extractedSkills,
   })

4. Store google-compat metadata:
   - base_agent reference
   - base_environment config (for runtime source injection)
   - network allowlist config

5. Return Google-format agent response
```

### Agent CRUD (GET, LIST, DELETE)

Thin reshaping — strip gateway fields (engine, webhook_*, etc.), add Google fields (base_agent, base_environment).

### File Download (`GET /google/v1beta/files/environment-:envId:download`)

- Find sessions in environment
- Collect output files from `files` table (scope_type=session, scope_id in env sessions)
- Stream as tar archive

---

## New DB Table

```sql
CREATE TABLE IF NOT EXISTS google_interactions (
  id TEXT PRIMARY KEY,              -- interaction ULID
  session_id TEXT NOT NULL,         -- our session ID
  seq INTEGER NOT NULL DEFAULT 1,   -- turn number within session
  status TEXT NOT NULL DEFAULT 'completed',
  environment_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
```

---

## Implementation Phases

### Phase 1: Core MVP (streaming-first)
- Route registration in Hono adapter at `/google/v1beta/*`
- Auth middleware (`x-goog-api-key` → `x-api-key` copy)
- `POST /google/v1beta/interactions` with streaming (SSE translation)
- `POST /google/v1beta/interactions` non-streaming (wait + collect)
- `requires_action` handling for function calls
- `GET /google/v1beta/interactions/:id` (retrieve completed)
- `POST /google/v1beta/interactions/:id/cancel`
- `google_interactions` table + migration
- Multi-turn via `previous_interaction_id`
- Inline sources → skills/resources injection
- Unit tests for every translation function
- Integration test: end-to-end with real agent

### Phase 2: Agent Management + Environment
- `POST /google/v1beta/agents` (create with sources)
- `GET /LIST/DELETE /google/v1beta/agents`
- Environment lifecycle for `"remote"` (auto-create, TTL cleanup)
- Repository sources → github_repository resources
- `base_agent` configurable mapping (settings)
- Network allowlist config (store, plan enforcement)

### Phase 3: Extended Features
- `GET /google/v1beta/files/environment-:id:download` (tar archive)
- `background: true` mode (create + poll pattern)
- `generation_config` passthrough (temperature, thinking_level)
- `webhook_config` → our webhook system
- `store: false` mode (ephemeral, no DB persistence)
- Compatibility test: point real `google-genai` Python SDK

---

## Constraints & Decisions

- **Confirmation-mode agents**: Rejected from Google compat (400 error). Google's API has no approval flow.
- **Custom tool results**: Supported via `requires_action` + follow-up interaction with `function_result` input.
- **ID semantics**: Each interaction gets a unique ID (ULID). `previous_interaction_id` resolves to session_id via lookup table. Multiple interactions map to one session.
- **Environment lifecycle**: `"remote"` creates an auto-expiring environment (TTL from config, default 7 days matching Google's behavior). Reused across interactions in same session.
- **system_instruction**: Stored as agent-level system prompt. Per-interaction overrides create a temporary agent version (NOT prefixed to user message — that's lossy for multi-turn).
- **Unsupported Google features**: `google_search` tool (we use the agent's built-in search), `computer_use` tool, `file_search` tool, `google_maps` tool, `retrieval` tool. These return 400 with clear error message.
- **MCP tools**: Google's `mcp_server` tool type maps directly to our `mcp_servers` on the agent.

---

## File Structure

```
packages/agent-sdk/src/handlers/google-compat/
├── index.ts              — route registration (exported for Hono/Fastify/Next adapters)
├── interactions.ts       — POST/GET/DELETE/cancel interaction handlers
├── agents.ts             — CRUD handlers for agents
├── files.ts              — environment tar download
├── translate.ts          — request/response translation utilities
├── events.ts             — SSE event stream translation (internal → Google format)
└── types.ts              — Google API type definitions

packages/agent-sdk/src/db/google-interactions.ts  — DB operations for mapping table
```

Server adapters (gateway-hono, gateway-fastify, gateway-next) each mount the exported router at `/google/v1beta`.

---

## Testing Strategy

- **Unit**: Translation functions (request → internal, internal events → Google steps/SSE)
- **Integration**: Full flow — create interaction → stream → collect response
- **Error paths**: Agent errors, timeout, budget exceeded, concurrent interactions
- **Multi-turn**: previous_interaction_id with function_result re-entry
- **Streaming**: Event-by-event SSE translation coverage
- **Auth**: x-goog-api-key propagation through routeWrap
- **SDK compat**: Point `google-genai` Python SDK at our endpoint (Phase 3)
