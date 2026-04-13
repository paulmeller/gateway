# AgentStep Gateway

One API. Any Agent. Anywhere.

The harness that harnesses other harnesses! Run AI agents across multiple backends from a single API. Switch between Claude, Codex, OpenCode, Gemini, and Factory with one config change. Your code, prompts, and outputs stay on your infrastructure. Zero vendor lock-in.

## Features

- **Multi-backend** — Claude, Codex, OpenCode, Gemini, Factory behind one API
- **Claude Managed Agents compatible** — implements the Anthropic Managed Agents API
- **Sandboxed environments** — 10 providers: local (Docker, Podman, Apple Container, AgentStep Firecracker microVM) and cloud (Sprites, E2B, Fly, Vercel, Daytona, Modal)
- **Multi-agent threads** — agents can spawn other agents, max depth 3
- **Self-hosted** — runs on your infrastructure, data never leaves your machine
- **CLI-first** — `gateway quickstart` gets you chatting in under 5 minutes
- **Built-in web UI** — dashboard at localhost:4000
- **Open source** — Apache 2.0 license, no CLA

## Quick Start (AI-Guided)

The fastest way to get started — Claude Code walks you through everything:

```bash
git clone https://github.com/agentstep/gateway.git
cd gateway
claude
> /setup-gateway
```

The `/setup-gateway` skill is included in the repo. It checks prerequisites, configures secrets, starts the server, and runs your first session.

## Quick Start (Docker)

```bash
docker run -p 4000:4000 -e ANTHROPIC_API_KEY=sk-ant-... ghcr.io/agentstep/gateway
```

Or with docker compose:

```bash
git clone https://github.com/agentstep/gateway.git
cd gateway
export ANTHROPIC_API_KEY=sk-ant-...
docker compose up
```

Server starts at http://localhost:4000 with UI, API (`/v1`), and docs (`/v1/docs`).

## Quick Start (npm)

### Prerequisites

- Node.js 18+
- At least one API key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`

### Install the CLI

```bash
npm install -g @agentstep/gateway
```

### Run from source

```bash
git clone https://github.com/agentstep/gateway.git
cd gateway
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

### First Session

```bash
gateway quickstart
```

Creates an agent + environment + session and drops you into an interactive chat.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `packages/agent-sdk` | [`@agentstep/agent-sdk`](https://www.npmjs.com/package/@agentstep/agent-sdk) | Engine — backends, providers, DB, session management |
| `packages/gateway` | [`@agentstep/gateway`](https://www.npmjs.com/package/@agentstep/gateway) | CLI tool (`gateway`) |
| `packages/gateway-hono` | `@agentstep/gateway-hono` | Example: Hono server (used by `gateway serve`) |
| `packages/gateway-fastify` | `@agentstep/gateway-fastify` | Example: Fastify server |
| `packages/gateway-next` | `@agentstep/gateway-next` | Example: Next.js integration |

The server packages are reference implementations. The hosted product ([agentstep.com](https://www.agentstep.com)) uses `@agentstep/agent-sdk` directly.

### Backends

Claude, Codex, OpenCode, Gemini, Factory.

### Environment Providers

Sprites (default), Docker, Apple Container, Apple Firecracker, Podman, E2B, Vercel, Daytona, Fly, Modal.

## CLI

```bash
gateway agents create --name mybot --model claude-sonnet-4-20250514
gateway environments create --name dev --provider docker
gateway sessions create --agent <id> --environment <id>
gateway quickstart                    # one-command agent + env + session
gateway serve                         # start the API server
gateway chat <session-id>             # interactive chat
gateway config set <key> <value>      # configure CLI
```

All commands support `--remote <url>` for connecting to a remote server and `-o json` for JSON output.

## Development

```bash
npm install          # install dependencies
npm run dev          # start Hono dev server
npm run dev:next     # start Next.js dev server
npm test             # run tests
npm run typecheck    # type checking
```

## License

[Apache 2.0](LICENSE)
