# Changelog

All notable changes to AgentStep Gateway are documented here. Dates are UTC.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [SemVer](https://semver.org/).

## [0.5.0] — 2026-04-17

### Added

- **Tenancy** — agents, environments, vaults, sessions, and API keys now
  carry a `tenant_id`. Three roles: **global admin** (`tenantId=null +
  admin`), **tenant admin** (`tenantId=X + admin`), **tenant user**
  (`tenantId=X`). Tenant admins see only their tenant; global admins see
  everything. Cross-tenant `id` lookups return 404 (not 403) to prevent
  id-probing. Admin API at `/v1/tenants`; UI settings page at `/tenants`.
  Legacy installs keep working — pre-0.5 keys hydrate as global admins
  and resources default to `tenant_default` (seeded on boot).
- **Migration path** — `gateway tenants migrate-legacy` is an
  interactive, opt-in CLI that stamps all null-tenant rows onto a
  chosen tenant. Nothing auto-migrates; upgrades from 0.4 are a no-op
  at the database level until the command is run.
- **Cross-tenant fallback guard** — the session-creation fallback chain
  refuses to step across tenant boundaries. Each skipped tuple carries
  a specific reason (`fallback agent not found`, `fallback environment
  in different tenant`, etc.) so operators can debug stale config.
- **OpenAI + Gemini in the upstream-key pool** — generalized from
  Anthropic-only. Vault entries use `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY` respectively.
- **Webhook HMAC signatures** — optional per-agent `webhook_secret`.
  When set, outbound webhooks include `X-AgentStep-Signature:
  sha256=<hex>` and `X-AgentStep-Timestamp: <ms>`. The SDK exports a
  `verifyWebhookSignature()` helper for receivers (constant-time
  compare, ±5-minute replay window, case-insensitive headers).
- **Redis rate-limit backend** — set `RATE_LIMIT_BACKEND=redis` and
  `REDIS_URL=…` to share per-key counters across replicas. Uses atomic
  `INCR + PEXPIRE` on a rotating window key. `ioredis` is an *optional*
  dependency loaded dynamically; when requested but missing, boot
  fails loudly unless `RATE_LIMIT_BACKEND_ALLOW_FALLBACK=true` is set.
  Transient Redis errors fail *open* to memory for that one request.
- **Audit log** — append-only ledger of admin-sensitive operations
  (`tenants.*`, `api_keys.*`, `upstream_keys.*`). `GET /v1/audit-log` is
  admin-only and tenant-scoped. `gateway audit [--action ...]` CLI
  mirrors the same filters. Upstream-key-pool entries are tagged
  `tenant_id=null` since the pool is global.
- **CLI parity** — `gateway tenants rename`, `gateway upstream-keys
  {list,add,disable,enable,delete}`, `gateway audit`. The `add`
  command prompts for the value interactively so secrets don't leak
  into shell history.
- **`GET /v1/whoami`** — tiny caller-identity endpoint the UI uses to
  decide which controls to show (Tenants nav, UpstreamKeys pool,
  admin-only dialogs).

### Changed

- **Upstream-key pool is global-admin-only** — `POST/GET/PATCH/DELETE
  /v1/upstream-keys` all require global admin. Tenant admins get 403.
  The pool is a shared resource across every tenant; letting one
  tenant admin touch it was a cross-tenant hole.
- **`/v1/metrics/api` is global-admin-only** — the in-process ring
  buffer isn't tenant-partitioned so the snapshot would leak
  cross-tenant traffic patterns.
- **Corrupted-ciphertext auto-disable now logs specifically** — when
  the pool decrypts a row and fails, the warning calls out
  `VAULT_ENCRYPTION_KEY` rotation as the likely cause rather than a
  generic "disabled" line. Helps ops correlate a post-rotation outage.
- **Pure-proxy resources get `tenant_id`** — `proxy_resources` gained a
  `tenant_id` column. Resources created with `engine=anthropic` (no
  local mirror row) are now tenant-checked at every endpoint.

### Security

Closes cross-tenant access gaps introduced by tenancy:

- Upstream-key pool CRUD was admin-scoped instead of global-admin-scoped.
- `/v1/metrics/api` leaked cluster-wide throughput.
- Pure-proxy sessions (Anthropic backend, no local row) bypassed tenant
  checks on `GET`, `DELETE`, `archive`, and SSE `stream`.
- Session fallback was tenant-gated only when the primary agent had a
  non-null tenant; a null-tenant anchor silently allowed any
  cross-tenant fallback tuple.

### Operational notes

- **v0.4 → v0.5 upgrade**: no migration required to boot. Resources
  stay tenant-less (visible to global admins only) until you run
  `gateway tenants migrate-legacy`.
- **Clustered deployments** should set `RATE_LIMIT_BACKEND=redis +
  REDIS_URL` and `npm i ioredis` in the runtime image. Without this,
  each replica enforces its own per-key counter, effectively
  multiplying the limit by the replica count.
- **Webhook signing** is optional and off by default — existing
  receivers keep working unsigned. Rotate a secret via `PATCH
  /v1/agents/:id` with `{webhook_secret: "<32+ char hex>"}`. Note that
  active sessions pin the agent version they were created under; the
  new secret takes effect for *new* sessions only.

## [0.4.0] — 2026-04-16

### Added

- **Virtual keys** — `POST/GET/PATCH/DELETE /v1/api-keys` admin API plus
  full management UI on `/api-keys`. Per-key scope (`{agents, environments,
  vaults}` allow-lists with `"*"` sentinel), per-key budget ceiling,
  per-key RPM rate limit. Legacy single-key installs keep working because
  `["*"]` permissions hydrate as `{admin: true, scope: null}`.
- **Per-key cost attribution** — sessions capture `api_key_id` from the
  authenticating key. `/v1/metrics?group_by=api_key` groups costs per key;
  legacy sessions bucket under `__unattributed__`. `/v1/api-keys/:id/activity`
  returns recent sessions plus lifetime totals.
- **Time-series metrics** — `?time_bucket=hour|day|week` alongside
  `group_by=api_key` returns one series per key, top-10 keys tracked
  individually, remainder collapses into `__other__`. New recharts
  `LineChart` on the ApiKeys page.
- **Session fallback** — `agents.fallback_json` defines an array of
  `{agent_id, environment_id}` tuples tried on session-creation failure.
  Max 3 hops, cycle-detected. Triggers on env-not-ready, Anthropic
  upstream 5xx/429, and anything classifiable as retryable; does not
  fire on config/billing/scope errors.
- **Upstream-key pool** — per-provider credential pool with LRU selection
  and 3-strike auto-disable. Admin API at `/v1/upstream-keys`. Anthropic
  only in v0.4; OpenAI/Gemini follow in 0.5.
- `tenant_id TEXT` column reserved on `api_keys` (no reads in v0.4 —
  forward-compat hook for v0.5 full tenant isolation).

### Changed

- `AuthContext` now carries the full `{admin, scope}` permissions object,
  plus `budgetUsd`, `rateLimitRpm`, `spentUsd`, `tenantId`. Handlers that
  ignored auth before are source-compatible.
- `bumpSessionStats` is now transactional: session counters and the
  owning key's `spent_usd` update in a single DB transaction, preventing
  crash-induced under-reporting.
- Three scattered `resolveAnthropicKey` call sites (SSE tee, session
  creation, proxy forward) consolidated into a single helper at
  `providers/upstream-keys.ts`.

### Tests

518 → 560 passing. New test files: `test/api-keys-handlers.test.ts`
(29 tests) and `test/upstream-keys.test.ts` (13 tests).

## [0.3.8] — 2026-04-16

### Fixed / Changed

- **Skills catalog URL is now configurable.** New env vars `SKILLS_FEED_URL`
  / `SKILLS_INDEX_URL` and matching settings keys
  `skills_feed_url` / `skills_index_url`. Default flipped from a
  third-party personal GitHub account to `www.agentstep.com/v1/skills/*`
  — removes a supply-chain concern (anyone with write access to the
  previous repo could push arbitrary JSON that every gateway would then
  fetch on the Skills page). Operators running air-gapped can point at
  a self-hosted mirror.
- Index parser now accepts both `{count, items}` and `{totalSkills, skills}`
  response shapes, so the backend endpoint can ship either schema.
- Server-side rejection of `sk-ant-oat*` OAuth tokens for the anthropic
  sync-and-proxy provider (wizard already rejected them; this closes the
  API-direct path that the docs claimed was blocked).
- Minor doc drift: `docs/telemetry.md` cli_version example updated.

## [0.3.7] — 2026-04-16

### Fixed

- **`gateway version` printed "dev"** on the installed npm tarball
  because the path resolver didn't know it was running from the bundled
  `dist/`. Now tries multiple candidate paths and validates by
  package name. Every 0.3.6 install will see "dev" until upgraded.
- **README overclaimed `@anthropic-ai/sdk` compatibility.** The
  upstream SDK doesn't yet expose the `managed-agents-2026-04-01` beta
  endpoints, so the README now honestly recommends raw `fetch` / curl
  with the `anthropic-beta` header.
- **Quickstart Vercel/Modal/Fly fields were single-use** — non-secret
  fields (`VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `MODAL_TOKEN_SECRET`,
  `FLY_APP_NAME`) were only set on `process.env` for the quickstart's
  lifetime. After exit, providers failed at runtime. All fields now
  persist to the settings table. Provider modules read env→settings
  fallback via a new `readEnvOrSetting` helper.
- **Hono + Fastify adapters leaked the API key behind a reverse
  proxy.** Same-host Caddy/Nginx deployments see the socket as
  127.0.0.1 always. Honors `X-Forwarded-For` only when `TRUST_PROXY=1`
  is set, matching the Next adapter's default-closed posture.

## [0.3.6] — 2026-04-16

Closes four blockers from the third-architect review:

- gateway-next `x-real-ip` no longer trusted without `TRUST_PROXY=1` (same class as the original LAN leak)
- `docker-compose.yml` volume path fixed (`/home/node/app/data`) — previously bypassed the vault-key persistence
- Deleted 1700 lines of dead legacy static UI from the agent-sdk tarball
- Cleaned up scrubbed attribution stubs, verbose [tee] and [lifecycle] logs gated behind DEBUG_SYNC and DEBUG_LIFECYCLE
- Added npm metadata (keywords, homepage, bugs, author) for discoverability
- README Packages table relabeled (4 of 6 packages are source-only, not npm)

## [0.3.5] — 2026-04-16

### Security

- **Fastify + Next UI adapters** now gate `window.__MA_API_KEY__` injection
  to loopback-remote requests (previously only the Hono adapter did). Without
  this, any LAN-reachable deployment of either adapter still leaked the
  gateway's API key via the HTML returned at `/`.
- **Docker vault key persistence.** `VAULT_ENCRYPTION_KEY_FILE` is now
  honored by the vault module. The Dockerfile sets it to
  `/home/node/app/data/.vault-key` (inside the `VOLUME`) so the key
  survives container recreation. Previously the key landed in `.env`
  outside the volume, orphaning all encrypted entries on every restart.
- **Telemetry error path no longer leaks raw argv.** The `.catch()`
  handler at `packages/gateway/src/index.ts` now sends only the command
  name chain, matching the success path and `docs/telemetry.md`.
- **Dev server default bind.** `npm run dev` is now loopback
  (`HOST=0.0.0.0` to expose), matching `gateway serve`.
- **Next adapter loopback detection fails closed.** `x-forwarded-for`
  and `x-real-ip` are only trusted under explicit `TRUST_PROXY=1`;
  otherwise no auto-login.

### Operational

- Repository history re-squashed. Pre-0.3.1 tags contained committed
  SQLite DB files with vault secrets. All leaked keys have been rotated
  with their providers; the old commits and tags are removed from both
  public remotes. Single-commit history starts at v0.3.5.

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
