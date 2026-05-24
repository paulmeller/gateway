# Google Managed Agents API Compatibility Layer

> Goal: Accept Google Gen AI SDK calls (`client.interactions.create()`, `client.agents.create()`)
> as an alternative API surface, translating them into our existing Anthropic-compatible primitives.
> No new business logic — pure adapter layer.

## Context

Google launched Managed Agents on the Gemini API (May 2026). Their SDK uses a simpler,
one-shot-per-turn model: `interactions.create()` sends a prompt, waits for completion,
returns the result. Our Anthropic-compatible surface is richer (multi-turn sessions,
SSE streaming, MCP tools, confirmation flow), but some users prefer the Google SDK's
simplicity.

By supporting both API surfaces, we let users choose their SDK without changing the
underlying engine. A single gateway instance can serve Anthropic SDK clients on `/v1/*`
and Google SDK clients on `/v1beta/*` simultaneously, powered by the same agents and
environments.

## Route Surface

| Google Endpoint | Method | Internal Mapping |
|----------------|--------|------------------|
| `POST /v1beta/interactions` | POST | Create session → send message → wait idle → return |
| `POST /v1beta/agents` | POST | Create agent (translate sources → skills/resources) |
| `GET /v1beta/agents` | GET | List agents |
| `GET /v1beta/agents/:id` | GET | Get agent |
| `DELETE /v1beta/agents/:id` | DELETE | Delete agent |
| `GET /v1beta/files/environment-:id:download` | GET | Tar archive of session output files |

## Auth

- Accept `x-goog-api-key` header → treat as gateway API key (same as `x-api-key`)
- Accept `Api-Revision` header → ignore (we don't version-gate)

## Translation: `POST /v1beta/interactions`

This is the core endpoint. Google's interaction = session creation + one message turn + wait.

### Request (Google format)

```typescript
interface CreateInteractionRequest {
  agent: string;                      // agent ID
  input: string;                      // user message
  environment?: string | EnvironmentConfig; // "remote" | env_id | config object
  previous_interaction_id?: string;   // multi-turn → reuse session
  system_instruction?: string;        // per-interaction override
  tools?: ToolConfig[];               // tool overrides
  stream?: boolean;                   // SSE streaming
}

interface EnvironmentConfig {
  type: "remote";
  sources?: Source[];
  network?: { allowlist?: NetworkRule[] };
}

interface Source {
  type: "inline" | "repository";
  target: string;                     // filesystem path
  content?: string;                   // for inline
  source?: string;                    // for repository (URL)
}
```

### Translation Logic

```
1. Resolve agent:
   - Look up agent by ID (our agent name = google agent ID)
   - If not found, check if it's a base agent ref ("antigravity-preview-05-2026")
     → map to a default gemini agent

2. Resolve session:
   - If previous_interaction_id → reuse that session (it's a session ID)
   - Else → create new session:
     POST /v1/sessions {
       agent: { id: agentId },
       environment_id: resolve(environment),
       resources: translateSources(sources),
     }

3. Apply per-interaction overrides:
   - system_instruction → inject as a prefix to the user message
     (or update agent version if we add per-turn system override support)
   - tools → ignored in v1 (agent tools are fixed at creation)

4. Send message:
   POST /v1/sessions/:id/events {
     events: [{ type: "user.message", content: [{ type: "text", text: input }] }]
   }

5. Wait for completion:
   - Subscribe to SSE stream
   - Collect events until session.status_idle
   - Extract output_text from agent.message events
   - Extract steps from agent.tool_use + agent.tool_result events

6. Return response:
   {
     id: session_id,                   // interaction ID = session ID
     environment_id: env_id,
     output_text: collectedText,
     steps: collectedSteps,
   }
```

### Streaming Mode (`stream: true`)

Return SSE stream that emits:
- `event: step.delta` — partial text, tool calls
- `event: interaction.complete` — final result

Internally subscribes to our session SSE and translates events.

## Translation: `POST /v1beta/agents`

### Request (Google format)

```typescript
interface CreateAgentRequest {
  id: string;                          // agent name/ID
  description?: string;
  base_agent: string;                  // "antigravity-preview-05-2026"
  system_instruction?: string;
  tools?: ToolConfig[];
  base_environment?: string | BaseEnvironmentConfig;
}

interface BaseEnvironmentConfig {
  type: "remote";
  sources?: Source[];
  network?: { allowlist?: NetworkRule[] };
}
```

### Translation Logic

```
1. Map base_agent to engine:
   - "antigravity-preview-05-2026" → engine: "gemini", model: "gemini-2.5-flash"
   - Unknown → reject with 400

2. Translate sources to skills + resources:
   - source.target matches ".agents/skills/*/SKILL.md"
     → extract as skill { name, content }
   - source.target matches ".agents/AGENTS.md"
     → append content to system_instruction
   - source.type === "repository"
     → store as session resource template (github_repository)

3. Create agent:
   POST /v1/agents {
     name: request.id,
     engine: "gemini",
     model: { id: "gemini-2.5-flash" },
     system: system_instruction + AGENTS.md content,
     skills: extractedSkills,
   }

4. Store source/network config:
   - Persist in agent metadata or a new google_compat_config column
   - Applied at session creation time

5. Return:
   { id: agent.name, base_agent, system_instruction, ... }
```

## Translation: Agent CRUD

| Google | Internal |
|--------|----------|
| `GET /v1beta/agents` | `GET /v1/agents` → reshape response |
| `GET /v1beta/agents/:id` | `GET /v1/agents/:id` (lookup by name) → reshape |
| `DELETE /v1beta/agents/:id` | `DELETE /v1/agents/:id` |

Response reshaping: strip gateway-specific fields (engine, webhook_*, confirmation_mode),
add Google-specific fields (base_agent, base_environment).

## Translation: File Download

`GET /v1beta/files/environment-:envId:download`

1. Resolve environment → find sessions in that environment
2. Collect all output files from those sessions
3. Create tar archive in memory
4. Stream as `application/x-tar` response

## Environment Mapping

| Google `environment` value | Maps to |
|---------------------------|---------|
| `"remote"` | Create new environment with default provider (sprites) |
| `env_id` string | Reuse existing environment by ID |
| `{ type: "remote", sources, network }` | Create env + inject sources at session start |

## Sources → Skills/Resources Mapping

| Source | Target Pattern | Internal Primitive |
|--------|---------------|-------------------|
| `type: "inline"`, target: `.agents/AGENTS.md` | System prompt append |
| `type: "inline"`, target: `.agents/skills/<name>/SKILL.md` | Skill (extracted name + content) |
| `type: "inline"`, target: other | Session resource (file, mounted at target path) |
| `type: "repository"` | Session resource (github_repository, mounted at target) |

## Network Allowlist

Store on environment config as a new optional field:
```typescript
interface EnvironmentConfig {
  // ... existing fields
  network_allowlist?: Array<{
    domain: string;
    transform?: Record<string, string>; // headers to inject
  }>;
}
```

Implementation deferred — requires container-level network policy enforcement.
For v1, store the config but don't enforce (document as "planned").

## File Structure

```
packages/agent-sdk/src/handlers/google-compat/
├── index.ts              — route registration
├── interactions.ts       — POST /v1beta/interactions handler
├── agents.ts             — CRUD handlers for /v1beta/agents
├── files.ts              — environment tar download
└── translate.ts          — shared request/response translation utilities
```

## Implementation Phases

### Phase 1: Core (MVP)
- `POST /v1beta/interactions` (non-streaming)
- `POST /v1beta/agents` (with inline sources → skills)
- `GET/DELETE /v1beta/agents`
- `x-goog-api-key` auth header support
- Tests: unit tests for translation logic + integration test with real agent

### Phase 2: Streaming + Multi-turn
- `POST /v1beta/interactions` with `stream: true`
- `previous_interaction_id` for multi-turn
- Environment reuse across interactions

### Phase 3: Files + Network
- `GET /v1beta/files/environment-:id:download` (tar archive)
- Repository sources → github_repository resources
- Network allowlist config (store, document as planned)

## Non-Goals

- No new business logic — everything translates to existing primitives
- No Google-specific container behavior — same sprites/docker providers
- No Antigravity-specific features (Google's built-in tools) — we use our own engines
- No billing/quota enforcement beyond what we already have

## Testing Strategy

- Unit tests for each translation function (Google request → internal request)
- Integration test: create agent via Google API → run interaction → verify output
- Compatibility test: point actual `google-genai` Python SDK at our endpoint
