# AgentStep Gateway

**Same API, your infrastructure. Any agent/CLI engine.**

Anthropic's [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) run coding agents in cloud sandboxes through a clean REST API. But they're cloud-only, Claude-only, and Anthropic-hosted.

AgentStep Gateway is a self-hosted, open-source drop-in. Same API endpoints, same event model, same SSE stream. But you choose the engine (Claude, Codex, OpenCode, Gemini) and the sandbox (Docker, Sprites, E2B, Fly, or 7 others). Your code and prompts never leave your infrastructure.

[![npm](https://img.shields.io/npm/v/%40agentstep%2Fgateway)](https://www.npmjs.com/package/@agentstep/gateway)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<p align="center">
  <img src="assets/screenshot-home.png" alt="AgentStep Gateway — Home" width="800" />
</p>

## 30-Second Demo

```bash
npx @agentstep/gateway quickstart
```

Or with curl:

```bash
# Start the server
npm install -g @agentstep/gateway && gateway serve

# Create an agent
curl -X POST http://localhost:4000/v1/agents \
  -H "x-api-key: $(cat data/.api-key)" \
  -H "content-type: application/json" \
  -d '{"name": "fixer", "model": "claude-sonnet-4-6", "tools": [{"type": "agent_toolset_20260401"}]}'

# Create an environment (Docker sandbox)
curl -X POST http://localhost:4000/v1/environments \
  -H "x-api-key: $(cat data/.api-key)" \
  -H "content-type: application/json" \
  -d '{"name": "dev", "config": {"provider": "docker"}}'

# Start a session and send a message
curl -X POST http://localhost:4000/v1/sessions \
  -H "x-api-key: $(cat data/.api-key)" \
  -H "content-type: application/json" \
  -d '{"agent": "<agent_id>", "environment_id": "<env_id>"}'

curl -X POST http://localhost:4000/v1/sessions/<session_id>/events \
  -H "x-api-key: $(cat data/.api-key)" \
  -H "content-type: application/json" \
  -d '{"events": [{"type": "user.message", "content": [{"type": "text", "text": "Fix the lint errors in src/utils.js"}]}]}'
```

The agent spins up a container, runs the CLI, streams tool calls and messages back as SSE events. Same API shape as Anthropic's hosted service.

## What You Get

- **Any agent engine** -- Claude Code, OpenAI Codex, OpenCode, Gemini CLI, Factory, Pi. Switch with one field.
- **11 sandbox providers** -- Docker, Podman, Apple Container, Sprites, E2B, Vercel, Daytona, Fly, Modal, and more.
- **Custom tools** -- define tools on your agent, callers execute them server-side. Full `agent.custom_tool_use` / `user.custom_tool_result` round-trip.
- **Vault-encrypted secrets** -- AES-256-GCM at rest. API keys, tokens, and credentials never returned in plaintext.
- **Web UI included** -- React dashboard for chat, session replay, analytics. Embedded in the CLI binary, zero extra setup.
- **Sync-and-proxy mode** -- point at Anthropic's hosted Managed Agents and get the best of both: their sandbox, your config and observability.

<p align="center">
  <img src="assets/screenshot-analytics.png" alt="Agent Activity Analytics" width="400" />
  <img src="assets/screenshot-throughput.png" alt="API Throughput" width="400" />
</p>

## Install

```bash
npx @agentstep/gateway quickstart         # zero install, interactive setup

npm install -g @agentstep/gateway          # global install
gateway serve                              # server at http://localhost:4000

docker run -p 4000:4000 ghcr.io/agentstep/gateway   # Docker
```

From source:

```bash
git clone https://github.com/agentstep/gateway.git
cd gateway && npm install && npm run dev
```

Prerequisites: Node.js 22+, and at least one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`.

## How It Works

1. **Create an agent** -- name, model, engine, system prompt, tools, MCP servers.
2. **Create an environment** -- pick a sandbox provider (Docker, Sprites, E2B, ...).
3. **Start a session** -- the gateway lazy-acquires a container on first turn.
4. **Send messages** -- `POST /v1/sessions/:id/events` with `user.message`.
5. **Stream results** -- `GET /v1/sessions/:id/stream` returns SSE events: `agent.message`, `agent.tool_use`, `session.status_idle`.

Each turn drives the agent CLI inside the container. NDJSON output is translated into the Managed Agents event model and streamed to your client.

## Anthropic Compatibility

The gateway implements the Anthropic Managed Agents API: `/v1/agents`, `/v1/vaults`, `/v1/environments`, `/v1/sessions`, `/v1/sessions/:id/events`, and SSE streaming. Three modes:

1. **Local** -- agent runs in your sandbox. No data leaves your machine.
2. **Sync-and-proxy** -- set `provider: "anthropic"`. The gateway syncs your agent config to Anthropic, creates a hosted session, and proxies traffic. Anthropic runs the sandbox; you keep the config and observability.
3. **Passthrough** -- set `ANTHROPIC_PASSTHROUGH_ENABLED=true`. Callers with their own `sk-ant-api*` keys are forwarded to Anthropic transparently. Same URLs, so any Anthropic SDK works as a drop-in.

See [`docs/guides/anthropic-integration.mdx`](docs/guides/anthropic-integration.mdx) for details.

## CLI

```bash
gateway quickstart                     # interactive setup
gateway serve [--host 0.0.0.0]        # start server
gateway agents create --name bot --model claude-sonnet-4-6
gateway environments create --name dev --provider docker
gateway sessions create --agent <id> --environment <id>
gateway chat <session-id>              # interactive chat with markdown rendering
```

All commands accept `--remote <url>` and `-o json`.

## Architecture

| Package | Description |
|---------|-------------|
| [`@agentstep/agent-sdk`](https://www.npmjs.com/package/@agentstep/agent-sdk) | Core engine -- backends, providers, DB, session orchestration, vault crypto |
| [`@agentstep/gateway`](https://www.npmjs.com/package/@agentstep/gateway) | CLI binary -- single-file bundle with web UI embedded |
| `@agentstep/gateway-hono` | Hono server adapter (powers `gateway serve`) |
| `@agentstep/gateway-ui` | React + shadcn/ui web app (inlined into CLI) |

The hosted product ([agentstep.com](https://www.agentstep.com)) uses `@agentstep/agent-sdk` directly -- same handler functions, same event model.

## Development

```bash
npm install && npm run dev     # Hono server on :4000, hot reload
npm test                       # 800+ tests
npm run typecheck              # tsc --noEmit
npm run build:ui               # rebuild React UI into CLI bundle
```

## License

[Apache 2.0](LICENSE)
