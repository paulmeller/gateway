# Anthropic Managed Agents integration

AgentStep Gateway can either **run agents locally** in your own sandboxes
or **sync-and-proxy to Anthropic's hosted Managed Agents API**. The API
surface is the same in both cases.

## Two distinct knobs

There are two independent choices: the **engine** (which LLM CLI does the
work on each turn) and the **provider** (where the sandbox runs).

| | Engine | Provider |
|---|---|---|
| What it is | The agent CLI/driver that runs a turn | The container runtime or hosted sandbox service |
| Examples | `claude`, `codex`, `opencode`, `gemini`, `factory` | `docker`, `apple-container`, `e2b`, `sprites`, `anthropic` |
| `anthropic` means | Not a valid engine (agents always run in a sandbox through a CLI) | **Sync-and-proxy to Anthropic's hosted Managed Agents** — see below |

## Local mode (default)

```bash
gateway agents create --name bot --engine claude --model claude-sonnet-4-6
gateway environments create --name dev --provider docker
gateway sessions create --agent <agent-id> --environment <env-id>
```

- The agent's config (tools, system prompt, MCP servers, model) lives in
  your local SQLite.
- Each session acquires a container from the provider on first turn.
- Turns drive the claude CLI inside the container. NDJSON → events → DB
  → SSE stream to the UI.

## Sync-and-proxy mode

Create an environment with `provider: "anthropic"`. The engine must be
`claude` — the hosted API runs Anthropic's own driver.

```bash
gateway environments create --name prod --provider anthropic
gateway agents create --name bot --engine claude --model claude-sonnet-4-6
# Store your Anthropic key somewhere the gateway can read it
gateway vaults create --name bot-vault
gateway vaults put-entry <vault-id> ANTHROPIC_API_KEY sk-ant-api03-...
gateway sessions create --agent <agent-id> --environment <env-id> --vault <vault-id>
```

On `sessions create`, the gateway:

1. **Resolves the API key** — vault entries take precedence over env vars
   and config. Real API keys only; `sk-ant-oat` OAuth tokens are rejected
   for this provider.
2. **Syncs your agent** to Anthropic's `/v1/agents` with the current
   config hash. If nothing changed since last sync, the existing remote
   agent is reused; otherwise a new remote agent is created.
3. **Syncs any attached vaults** to Anthropic's `/v1/vaults`. Note:
   secrets themselves aren't synced (Anthropic's vault secrets API is
   not yet public) — only the vault shape.
4. **Syncs the environment** to Anthropic's `/v1/environments`.
5. **Creates the remote session** and stores the local↔remote ID mapping
   in `anthropic_sync`.
6. **Streams events back** via a tee on the remote SSE endpoint. Events
   land in your local bus (dedup by event ID, filter user events already
   written by the POST handler) and are served to the UI exactly like
   locally-run sessions.
7. **Proxies execution traffic** — `POST /v1/sessions/:id/events` and
   the SSE stream are forwarded to Anthropic with the resolved API key
   substituted in. Your client sees one API; the heavy lifting happens
   on Anthropic's infra.

## What gets synced, what stays local

| Resource | Synced? | Notes |
|---|---|---|
| Agent config (system, tools, model, mcp_servers, model_config) | Yes | Tools default to `agent_toolset_20260401` if the agent has none configured. |
| Vault shape (name, entry keys) | Yes (shape only) | Secret values stay local; Anthropic's vault secrets API isn't public yet. |
| Environment | Yes | Remote ID cached in `anthropic_sync`. |
| Session | Created remotely | All events stored locally too — the UI reads from the local bus. |
| API keys | Never synced | Resolved at request time; passed to Anthropic as the `x-api-key` header. |

## Required headers

All calls to Anthropic include:
- `x-api-key: <resolved key>`
- `anthropic-version: 2023-06-01`
- `anthropic-beta: managed-agents-2026-04-01` (for REST)
- `anthropic-beta: agent-api-2026-03-01` (for the SSE `/stream` endpoint — the two betas aren't compatible in one header)

## Why use sync-and-proxy instead of direct Anthropic?

1. **Unified observability.** Every session — local *or* Anthropic-hosted —
   appears in the same UI, the same analytics dashboard, the same event
   stream.
2. **Config stays in your hands.** Agent definitions, vaults, MCP servers
   live in your SQLite. If you decide to self-host the sandbox tomorrow,
   flip the environment's provider and the agent config is already there.
3. **No vendor lock-in.** If Anthropic changes pricing or retires the API,
   point the same agent at a local Docker provider without touching your
   client code.

## Source of truth

- Sync orchestration: [`packages/agent-sdk/src/sync/anthropic.ts`](../packages/agent-sdk/src/sync/anthropic.ts)
- ID mapping table: [`packages/agent-sdk/src/db/sync.ts`](../packages/agent-sdk/src/db/sync.ts)
- Proxy forwarding: [`packages/agent-sdk/src/proxy/forward.ts`](../packages/agent-sdk/src/proxy/forward.ts)
- SSE tee: [`packages/agent-sdk/src/handlers/events.ts`](../packages/agent-sdk/src/handlers/events.ts) (search for `teeRemoteStream`)
- Tests: [`packages/agent-sdk/test/anthropic-sync.test.ts`](../packages/agent-sdk/test/anthropic-sync.test.ts)
