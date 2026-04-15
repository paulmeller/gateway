# AgentStep Gateway Console — UI Redesign

## Context

AgentStep Gateway is a developer API product — an open-source drop-in replacement for the Claude Managed Agents API. The current UI is chat-first (like a messaging app), but the product serves developers building on the API and ops people monitoring agents. Chat is a testing tool (playground), not the primary interface.

Reference products: Vercel Dashboard, Stripe Console.

## Design Decisions

- **Primary users:** Developers building on the API + ops monitoring agents
- **Navigation:** Resource-first left nav with full text labels (Stripe-style)
- **Home page:** Overview with stats, getting started cards, recent activity (two-column)
- **Playground:** Three-panel workbench (config | chat | events inspector)
- **First-run:** No mandatory wizard. Getting Started cards on Overview. Optional Quick Start wizard as a shortcut.
- **Code snippets:** Every resource page shows cURL/SDK code in a collapsible right panel
- **Naming:** "Secrets" in UI, `/v1/vaults` in API
- **Router:** TanStack Router (replaces Zustand state machine)
- **API Docs:** iframe to existing `/v1/docs` endpoint

## Navigation Structure

Permanent left sidebar:

```
● agentstep

OVERVIEW
  Home
  API Keys

RESOURCES
  Agents
  Environments
  Sessions
  Secrets
  Files
  Skills
  Memory

TOOLS
  Playground
  Dashboard
  API Docs

[theme toggle at bottom]
```

Note: Memory Stores included (was missing from initial spec). Skills page shows the 72k+ skills catalog browser. Repositories are part of the Files page (separate section).

## URL Structure

```
/                           → Home (Overview)
/api-keys                   → API Keys
/agents                     → Agents list
/agents/:id                 → Agent detail (Config, Skills, Advanced, Edit tabs)
/environments               → Environments list
/environments/:id           → Environment detail
/sessions                   → Sessions list
/sessions/:id               → Session detail (events, traces, usage)
/secrets                    → Secrets (vaults) list
/secrets/:id                → Vault detail with entries
/files                      → Files + Repositories
/skills                     → Skills catalog browser
/memory                     → Memory stores
/playground                 → Three-panel workbench
/playground/:sessionId      → Playground with specific session
/dashboard                  → Metrics/traces dashboard
/docs                       → API documentation (iframe)
/quickstart                 → Optional Quick Start wizard
```

## Pages

### Home (Overview)

Two-column layout:

**Left column (2/3):**
- Stats bar: active sessions, total agents, API calls (24h), token usage, cost
- Recent Activity: last 10 sessions with status, agent, duration, stop reason. Click → session detail.

**Right column (1/3):**
- Getting Started cards (dismissible, completion tracked via settings key): "Create your first agent", "Configure an environment", "Add API credentials", "Try the playground", "Quick Start" (launches wizard)
- API key quick-copy
- Links to docs/playground
- Once past getting started: quick actions, recent errors, usage summary

### Resource Pages (Agents, Environments, Sessions, Secrets, Files, Skills, Memory)

All follow the same pattern:

- **List view:** Title + description + "New" button. Table with resource-specific columns. Click row → detail view.
- **Detail view:** Full page with tabs (e.g. `/agents/:id`). Breadcrumb navigation: `Agents > my-agent > Config`. Back button returns to list.
- **Code panel:** Collapsible right panel with cURL / Python / TypeScript SDK snippets. Context-aware (shows the current resource's actual ID/name interpolated). Copy button per snippet. Templates live in `lib/code-snippets.ts` as static template strings with variable interpolation — NOT generated from OpenAPI.

**Skills page:** Shows the 72k+ skills catalog browser (search, sort, source filters) — already implemented in AgentSkillsTab. Promoted to standalone page.

**Files page:** Two sections — uploaded files (table with upload/download/delete) and saved repositories (URL + branch list).

### Playground (Three-Panel Workbench)

- **Left panel (config):** Agent picker, model display, environment picker, system prompt override, resources/files to attach, vault selection. Inline editing — changes create new session on first message.
- **Center panel (chat):** Message input, conversation thread, file upload (paperclip), stop button.
- **Right panel (inspector):** Tabs — Events (real-time SSE with colored type badges), Traces (span tree from observability), Usage (tokens + cost).

Sessions created in Playground are regular sessions visible under Sessions resource page. The playground URL updates to `/playground/:sessionId` when a session is active.

### Dashboard

Existing metrics/traces dashboard (from observability PR). Moved from sidebar button to nav item.

### API Docs

Iframe embedding the existing `/v1/docs` HTML page (already served by `handleGetDocs()`). Simple wrapper component.

### API Keys

Manage gateway API keys. Show current key, copy button.

### Quick Start

The existing OnboardingWizard component, launched from the Overview "Quick Start" card or via `/quickstart` route. Creates agent → env → secrets → session and redirects to Playground. Not deleted — just relocated from being the home page to being an optional flow.

## Routing

**Switch to TanStack Router.** The current Zustand state machine (`settingsOpen`, `dashboardOpen`, boolean flags) will not scale to 12+ pages with nested routes.

**Hono SPA catch-all:** Replace per-route `serveUI` entries with a single wildcard that serves the SPA for any non-`/v1/` and non-`/api/` path:

```ts
// Catch-all for SPA client routes (must be last)
app.get("*", (c) => {
  if (c.req.path.startsWith("/v1/") || c.req.path.startsWith("/api/")) return c.notFound();
  return serveUI();
});
```

## What Gets Removed

| Current | Replacement |
|---|---|
| Sidebar sessions list | Sessions resource page |
| Settings page with tabs | Each tab → top-level nav item |
| Chat as home page | Overview is home, chat in Playground |
| Debug panel toggle | Always-visible inspector in Playground |
| API key in sidebar footer | API Keys page + Overview |
| Dashboard/Settings footer buttons | Left nav items |
| Mandatory wizard on first visit | Optional Quick Start from Overview |
| Zustand boolean routing | TanStack Router |

## What Gets Kept (relocated)

| Component | Current location | New location |
|---|---|---|
| OnboardingWizard | ChatThread fallback | `/quickstart` route + Overview card |
| AgentsTab | Settings tab | `/agents` page |
| EnvironmentsTab | Settings tab | `/environments` page |
| VaultsTab | Settings tab | `/secrets` page |
| MemoryStoresTab | Settings tab | `/memory` page |
| ResourcesTab | Settings tab | `/files` page |
| AgentDetailPage | Settings sub-view | `/agents/:id` page |
| DashboardPage | Dashboard overlay | `/dashboard` page |
| ChatThread + ChatInput | Main area | Playground center panel |
| EventStream | Debug panel | Playground inspector |
| CommandPalette | Cmd+K | Updated with new nav commands |

## Implementation Phases

### Phase 1: Router + Navigation + Resource Pages
1a. Install TanStack Router, define route tree, create layout with new left nav
1b. Migrate existing tab components to standalone route pages
1c. Build Overview page (stats + getting started + activity)
1d. Build Sessions resource page (list + detail with events)
1e. Update Hono SPA catch-all
1f. Remove old SettingsPage, old sidebar, old app-store routing booleans

### Phase 2: Playground + Code Snippets + API Keys
2a. Three-panel Playground (config | chat | inspector)
2b. Code snippets panel on resource pages
2c. API Keys page
2d. API Docs page (iframe)

### Phase 3: Polish
3a. Getting Started cards with dismissal + completion tracking (needs settings key backend)
3b. Quick Start wizard as standalone route
3c. Keyboard shortcuts updated for new nav
3d. Command palette updated
3e. Theme persistence via localStorage
3f. Breadcrumb navigation on detail pages
3g. Mobile/responsive: left nav collapses to icons on small screens
3h. Playwright E2E tests updated

## Verification

1. Home page shows stats, getting started, recent activity
2. Left nav navigates to all resource pages
3. Each resource page shows list → detail → back flow
4. Code snippets panel shows correct examples per resource
5. Playground 3-panel layout: config changes, chat works, events stream
6. Quick Start wizard creates resources and opens playground
7. No mandatory wizard on first visit
8. All existing API functionality accessible through new UI
9. Dark mode works throughout
10. Browser back/forward navigation works
11. Direct URL access works (e.g. bookmark `/agents/agent_01KP...`)
