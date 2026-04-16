# Contributing to AgentStep Gateway

Thanks for your interest in contributing! This project is Apache 2.0-licensed and welcomes contributions of all kinds.

## Development Setup

```bash
git clone https://github.com/agentstep/gateway.git
cd gateway
npm install
npm test
npm run dev          # starts Hono dev server on :4000
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm test` and `npm run typecheck` to verify
4. Submit a pull request

## What to Contribute

- **Bug fixes** — open an issue first if it's non-trivial
- **New backends or providers** — follow the existing pattern in `packages/agent-sdk/src/backends/` or `packages/agent-sdk/src/providers/`
- **Documentation** — improvements to README, CLAUDE.md, or inline docs
- **Tests** — we use vitest, tests live in `packages/agent-sdk/test/`

## Code Style

- TypeScript with `strict: true`
- ESM modules throughout
- No CLA required — Apache 2.0 license covers all contributions

## Reporting Issues

Open a GitHub issue. Include steps to reproduce, expected behavior, and actual behavior. If it's a security issue, see [SECURITY.md](SECURITY.md) instead.
