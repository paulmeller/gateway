# Changelog

All notable changes to AgentStep Gateway are documented here. Dates are UTC.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [SemVer](https://semver.org/).

## [0.3.4] — 2026-04-16

### Added
- `gateway db` subcommand with `db reset` — wipes the local SQLite DB with
  live-server detection, Turso-replica refusal, `--include-files`,
  `--dry-run`, and non-TTY safety. Adds 38 tests.
- `gateway serve --host <addr>` flag. Default is now `127.0.0.1` (loopback);
  passing `0.0.0.0` prints a security warning.
- Home tile tooltips (info icon with description) on the overview page.
- `CHANGELOG.md`, `.env.example`, `.github/ISSUE_TEMPLATE/`.

### Changed
- **Security:** server default bind is now loopback. Public binds require
  explicit `--host 0.0.0.0`.
- **Security:** the UI no longer injects `window.__MA_API_KEY__` for
  requests from non-loopback clients, preventing LAN-wide credential leak
  when bound publicly.
- **Security:** `/v1/settings/:key` now masks provider secrets in the
  response body. Existing "configured" state is surfaced via a new
  `configured: boolean` field.
- `db reset` probe uses `/api/health` instead of a catch-all path.
- README lede rewritten around the Anthropic Managed Agents hook.
- Quickstart now prompts for all required provider env vars (Vercel,
  Modal, Fly need multiple).
- API key is masked in the `gateway serve` startup banner; full key is in
  `data/.api-key` and `.env` only.
- Overview page API key is masked by default with reveal + copy.
- Home pulse row cut from 6 tiles to 4 (dropped API p95 + Error rate,
  both live on `/dashboard`). Each tile gained an info tooltip.

### Fixed
- `observability/api-metrics.ts`: `error_rate` is now 5xx-only. 4xx is
  client behavior (404s from UI polling during navigation, 401s) and was
  inflating health signals to ~24% on fresh installs.
- Agent detail routing (`/settings/agents/:id` → `/agents/:id`). The old
  URL was a 404 after the TanStack Router refactor.
- Sidebar height cap (`h-svh overflow-hidden`) — prevents pages from
  pushing the entire layout below the viewport when content is tall.
- Playground center column scrolls within the viewport with a pinned
  ChatInput at the bottom.
- `syncAgent` now passes `agent.tools` to Anthropic's `/v1/agents`
  endpoint; without this, managed agents were created with no tools.
- Wizard-created claude agents default to the full built-in toolset
  (previously empty `tools: []` disabled every tool via `--disallowed-tools`).
- `packages/gateway/package.json` repo URL corrected to `agentstep/gateway`.
- Node engines bumped to `>=22` (matches the real build target).
- Vault name is now editable in the onboarding wizard (was hardcoded to
  `my-vault`).

### Tests
- 515 total passing (477 agent-sdk + 38 gateway). Added
  `anthropic-sync.test.ts`, `db-reset.test.ts`, GET /v1/settings masking
  tests, and a regression test for empty-`tools` resolution.

## [0.3.3] — 2026-04-16

Initial public release. Anthropic Managed Agents sync-and-proxy, vault
encryption at rest, welcome hero empty state, Home analytics pulse row,
engine/provider compatibility enforcement, defensive wizard rules.

## [0.3.1] — 2026-04

First tagged release on GitHub.
