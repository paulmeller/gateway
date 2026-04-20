# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev              # Hono dev server (localhost:4000)
npm run dev:next         # Next.js dev server
npm test                 # vitest (core package)
npm run typecheck        # tsc --noEmit (core package)

# Run a single test
npx vitest run packages/agent-sdk/test/bus.test.ts

# Build CLI bundle
cd packages/gateway && node build.js

# Test CLI locally
node packages/gateway/dist/gateway.js --help

# Build React UI (gateway-ui → single HTML → ui.ts → CLI bundle)
npm run build:ui

# Docker
docker compose up                    # run with docker compose
docker build -t gateway . && docker run -p 4000:4000 gateway  # standalone
```

## Architecture

TypeScript monorepo under `@agentstep/*` scope. Six packages:

- **`@agentstep/agent-sdk`** (`packages/agent-sdk`) — framework-agnostic engine. All business logic lives here. Handlers accept `Request` → return `Response`.
- **`@agentstep/gateway`** (`packages/gateway`) — CLI tool. Bundles everything via esbuild into a single `dist/gateway.js`. The `LocalBackend` routes all operations through agent-sdk handler functions (same code path as the web app).
- **`@agentstep/gateway-ui`** (`packages/gateway-ui`) — React + shadcn/ui web app. Builds to single HTML via Vite + vite-plugin-singlefile, then inlined into the CLI bundle.
- **`@agentstep/gateway-hono`** (`packages/gateway-hono`) — Hono server adapter (powers `gateway serve`).
- **`@agentstep/gateway-fastify`** (`packages/gateway-fastify`) — Fastify server adapter.
- **`@agentstep/gateway-next`** (`packages/gateway-next`) — Next.js integration.

The server packages are thin route adapters. The hosted product (agentstep.com) uses `@agentstep/agent-sdk` directly.

**Critical: Both CLI and web app use the same handler functions.** The CLI's `LocalBackend` constructs `Request` objects and calls handlers — never imports DB functions directly.

### UI build pipeline

```
packages/gateway-ui/     →  Vite build  →  dist/index.html (single file)
scripts/build-ui.ts      →  reads dist/index.html  →  generates packages/agent-sdk/src/handlers/ui.ts
packages/gateway/build.js →  esbuild bundles ui.ts into dist/gateway.js
```

Run `npm run build:ui` to rebuild the full pipeline.

### Session lifecycle

The turn driver (`packages/agent-sdk/src/sessions/driver.ts`) orchestrates everything:

1. User message arrives → `enqueueTurn()` → global queue enforces concurrency limits (global + per-environment)
2. Sprite (container) is lazy-acquired on first turn
3. Backend's `buildTurn()` produces `{argv, env, stdin}` — driver owns stdin framing
4. Exec streams NDJSON through a backend-specific `Translator` → typed events batch-appended to DB
5. Stop reasons: `end_turn`, `error`, `interrupted`, `custom_tool_call`

### Key abstractions

**Per-session actor** (`sessions/actor.ts`): FIFO promise-chain that serializes all mutations per session.

**Event bus** (`sessions/bus.ts`): Append-only log. DB is authoritative; EventEmitter provides live tail.

**Backend interface** (`backends/types.ts`): `buildTurn()`, `createTranslator()`, `prepareOnSprite()`, `validateAgentCreation()`. Six implementations: claude, opencode, codex, gemini, factory, pi.

**Provider interface** (`providers/types.ts`): `create()`, `delete()`, `exec()`, `startExec()`. Eleven implementations: sprites (default), docker, apple-container, apple-firecracker, podman, e2b, vercel, daytona, fly, modal, mvm. Lazy dynamic imports in `providers/registry.ts`.

**Config cascade** (`config/index.ts`): env vars → settings DB table → defaults. Cached 30s. Use `PUT /v1/settings` or `writeSetting()` to persist.

### HTTP pattern

All handlers use `routeWrap()` from `http.ts` which handles init-on-first-request, auth, and error envelopes. Hono, Fastify, Next.js adapters, and the CLI's LocalBackend all call these same handler functions.

### DB

libsql (SQLite) with WAL mode. Schema is idempotent (`CREATE TABLE IF NOT EXISTS` in `db/migrations.ts`). On first run, auto-seeds an API key and writes it to `.env`.

### CLI features

- **Interactive quickstart**: `@clack/prompts` with arrow-key selection for agents, environments, providers
- **Rich chat output**: Markdown rendering via custom chalk renderer, box-drawn tool call sections, token usage display
- **Multi-line input**: Type `"""` to enter/exit multi-line mode in chat
- **Session info header**: Shows agent name, model, environment on chat start
- **Elapsed time spinner**: "Agent is thinking... (3s)"
- **Debug**: `DEBUG_NDJSON=1` shows raw NDJSON, exec argv, and stderr from backends

### Tests

518 tests across 32 test files (480 agent-sdk + 38 gateway):
- `packages/agent-sdk/test/api-comprehensive.test.ts` (~200) — full API surface + settings masking
- `packages/agent-sdk/test/cli-local-backend.test.ts` — CLI handler-based flow
- `packages/agent-sdk/test/translator-*.test.ts` — all backend translators + error handling
- `packages/agent-sdk/test/anthropic-sync.test.ts` — sync-and-proxy flow + headers
- `packages/agent-sdk/test/vault-crypto.test.ts` — AES-GCM round-trip, bad key handling
- `packages/agent-sdk/test/api-metrics.test.ts` — 5xx-only error rate
- `packages/gateway/test/db-reset.test.ts` (38) — planReset/performReset + IO
- Plus unit tests for bus, actor, tools, sweeper, ndjson, mcp-auth
