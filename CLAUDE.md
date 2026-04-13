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

# Docker
docker compose up                    # run with docker compose
docker build -t gateway . && docker run -p 4000:4000 gateway  # standalone

# Rebuild built-in UI after editing ui/{index.html,style.css,app.js}
npx tsx scripts/build-ui.ts
```

## Architecture

TypeScript monorepo under `@agentstep/*` scope. Five packages:

- **`@agentstep/agent-sdk`** (`packages/agent-sdk`) — framework-agnostic engine. All business logic lives here.
- **`@agentstep/gateway`** (`packages/gateway`) — CLI tool. Bundles everything via esbuild into a single `dist/gateway.js`.
- **`@agentstep/gateway-hono`** (`packages/gateway-hono`) — example Hono server (powers `gateway serve`).
- **`@agentstep/gateway-fastify`** (`packages/gateway-fastify`) — example Fastify server.
- **`@agentstep/gateway-next`** (`packages/gateway-next`) — example Next.js integration.

The server packages are reference implementations. The hosted product (agentstep.com) uses `@agentstep/agent-sdk` directly.

Packages serve raw `.ts` files (no build step except the CLI bundle). They reference each other via workspace `"*"` versions.

### Session lifecycle

The turn driver (`core/src/sessions/driver.ts`) orchestrates everything:

1. User message arrives → `enqueueTurn()` → global queue (`core/src/queue/index.ts`) enforces concurrency limits (global + per-environment)
2. Sprite (container) is lazy-acquired on first turn
3. Backend's `buildTurn()` produces `{argv, env, stdin}` — driver owns stdin framing (`envLines + "\n\n" + promptBody`)
4. Exec streams NDJSON through a backend-specific `Translator` → typed events batch-appended to DB
5. Stop reasons: `end_turn`, `error`, `interrupted`, `custom_tool_call` (triggers server-side tool dispatch or thread spawn)

### Key abstractions

**Per-session actor** (`sessions/actor.ts`): FIFO promise-chain that serializes all mutations per session. Stored on `globalThis` for HMR safety.

**Event bus** (`sessions/bus.ts`): Append-only log. DB is authoritative; EventEmitter provides live tail. Subscribers backfill from DB then tail the emitter.

**Backend interface** (`backends/types.ts`): `buildTurn()`, `createTranslator()`, `prepareOnSprite()`, `validateAgentCreation()`. Five implementations: claude, opencode, codex, gemini, factory. Registry in `backends/registry.ts`.

**Provider interface** (`providers/types.ts`): `create()`, `delete()`, `exec()`, `startExec()`. Nine implementations: sprites (default), docker, apple, podman, e2b, vercel, daytona, fly, modal. Lazy dynamic imports in `providers/registry.ts`.

**Config cascade** (`config/index.ts`): env vars → settings DB table → defaults. Cached 30s.

### Global state

All mutable singletons live on `globalThis` (HMR-safe pattern for Next.js dev): DB client, turn queue, per-session emitters, per-session actors, in-flight runs, config cache. Defined in `core/src/state.ts`.

### HTTP pattern

All handlers use `routeWrap()` from `core/src/http.ts` which handles init-on-first-request, auth, and error envelopes. Hono, Fastify, and Next.js adapters just wire routes to these handlers.

### Multi-agent threads

`sessions/threads.ts`: `spawn_agent` tool creates child sessions (max depth 3), runs them to completion, returns result as tool response. Parent blocks until child finishes.

### DB

libsql (SQLite) with WAL mode. Schema is idempotent (`CREATE TABLE IF NOT EXISTS` in `db/migrations.ts`). Supports optional Turso embedded replica via `TURSO_URL` + `TURSO_AUTH_TOKEN`.

### Init sequence

`ensureInitialized()` in `core/src/init.ts` runs once on first request: boots DB, seeds API key, recovers stale sessions (running → idle), reconciles orphan sprites, starts periodic sweeper.
