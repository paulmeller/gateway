# Gateway UI Rebuild: React + shadcn/ui

## Context

The built-in web UI for `gateway serve` is a ~1,345-line vanilla JavaScript SPA inlined as a template literal into the gateway CLI bundle. It works but has compounding issues: event delegation bugs (e.g. Cancel buttons not firing due to `stopPropagation`), disconnected Config/Chat/Events tabs forcing constant context switching, and a monolithic codebase that's hard to extend. This rebuild replaces it with a React + shadcn/ui app using a chat-first layout that integrates configuration and debugging directly into the chat workflow.

## Design: Chat-First with Contextual Access

### Layout

Three zones, all anchored to chat:

```
+--------+-------------------------------------------+
| Sidebar|  Session Header (agent | env | debug)     |
| 240px  |--------------------------------------------|
|        |                                            |
| Session|           Chat Thread                      |
| List   |           (messages + input)               |
|        |                                            |
|        |--------------------------------------------|
|        |  Debug Panel (toggled, resizable)          |
|        |  Live event stream for current session     |
+--------+-------------------------------------------+
```

**Left sidebar** (240px, collapsible):
- API key input in header (stored in localStorage)
- Gear icon opens Settings drawer
- "+ New Session" button at top, expands to inline form (agent + environment selectors)
- Session list grouped by: Active (status=running), Recent, Archived
- Each item: agent name, status badge, last message preview, timestamp
- Click to select, right-click or hover for archive/delete

**Main area:**
- Sticky session header bar: agent name (clickable popover), environment name (clickable popover), status badge, "Debug" toggle button
- Chat thread: scrollable message list with auto-scroll on new messages
- Input bar at bottom: auto-growing textarea, Send button (Enter to send, Shift+Enter for newline)
- Empty state when no session selected: prompt to create or select a session

**Bottom debug panel** (toggled via header button, resizable):
- Live event stream for the current session
- Driven by the same SSE connection as the chat (no additional API calls)
- Each row: sequence number, type badge (color-coded), content preview, token counts, delta time
- Click to expand full JSON payload
- Copy all events as JSON button

### Configuration Access

**Per-session (frequent) — Popovers:**
Clicking the agent name in the session header opens a Popover showing:
- Model and engine
- System prompt (truncated, expandable)
- Tools list
- MCP servers
- "Edit" button opens a full Dialog with YAML/JSON editor

Clicking the environment name shows:
- Provider and state
- Container status
- Associated vault info

**Admin (infrequent) — Settings Drawer:**
A Sheet sliding from the left, triggered by gear icon in sidebar. Contains three tabs:

1. **Agents** — List with create/edit/delete. Create form: name, engine selector, model selector. Edit opens the same Dialog as the popover's Edit button.
2. **Environments** — List with create/delete. Create form: name, provider selector.
3. **Vaults** — Vault list with entry management. Create vault (requires agent selection), add/edit/delete entries.

### Command Palette (Cmd+K)

shadcn `Command` component providing quick actions:
- Switch session (type to search)
- Create session / agent / environment
- Open settings
- Toggle debug panel

### Onboarding

When no agents or environments exist, the main area renders a 4-step wizard using shadcn Card components:

1. **Create Agent** — Select engine (Claude, OpenCode, Codex, Gemini, Factory), pick model
2. **Create Environment** — Select provider (Docker, Apple Container, Podman, or cloud options)
3. **Add Secrets** — Conditional API key inputs based on engine/provider combo. Can skip.
4. **Ready** — Summary card, "Start Chatting" button creates first session

### Message Rendering

Message types and their rendering:
- `user.message` — Right-aligned bubble, plain text
- `agent.message` — Left-aligned bubble, rendered as Markdown via `react-markdown` + `rehype-sanitize`
- `agent.thinking` — Left-aligned, muted/italic styling, collapsible
- `agent.tool_use` / `agent.custom_tool_use` — Collapsible card showing tool name + input JSON
- `agent.tool_result` — Nested under tool_use, collapsible with output
- `session.error` — Red error card
- `session.status_running` — Typing indicator (animated dots)
- `session.status_idle` — Typing indicator removed

### SSE / Real-Time

- Single SSE connection per active session via `GET /v1/sessions/:id/stream?after_seq=N`
- Reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
- New events pushed into TanStack Query cache directly (messages query + events query)
- AbortController for cleanup on session switch or unmount

## Technical Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Framework | React 19 | Component model, ecosystem |
| UI Components | shadcn/ui | Radix primitives, Tailwind styling, accessible |
| Styling | Tailwind CSS v4 | Utility-first, purged in production |
| State (UI) | Zustand | Minimal, no boilerplate |
| State (server) | TanStack Query v5 | Caching, refetching, SSE integration |
| Markdown | react-markdown + rehype-sanitize | React-native rendering, no innerHTML |
| Build | Vite | Fast dev, optimized production builds |
| Single-file | vite-plugin-singlefile | Inlines all JS/CSS into one HTML file |

## Component Tree

```
packages/gateway-ui/
  src/
    main.tsx                    # React entry, mounts App
    App.tsx                     # AppShell + QueryClientProvider + Toaster
    components/
      layout/
        AppShell.tsx            # sidebar + main + debug panel
        Sidebar.tsx             # session list, API key, gear icon
        SessionHeader.tsx       # agent/env popovers, debug toggle
        DebugPanel.tsx          # resizable bottom event viewer
      chat/
        ChatThread.tsx          # scrollable message list
        ChatInput.tsx           # textarea + send
        MessageBubble.tsx       # single message rendering
        ToolCallCard.tsx        # collapsible tool use/result
        TypingIndicator.tsx     # animated dots
      sessions/
        SessionList.tsx         # grouped session items
        SessionItem.tsx         # single session row
        NewSessionForm.tsx      # inline agent/env selector
      popovers/
        AgentPopover.tsx        # agent config quick view
        EnvironmentPopover.tsx  # env status quick view
      settings/
        SettingsDrawer.tsx      # Sheet with tabs
        AgentsTab.tsx           # agent CRUD
        EnvironmentsTab.tsx     # environment CRUD
        VaultsTab.tsx           # vault + entry management
        AgentEditorDialog.tsx   # YAML/JSON editor dialog
      events/
        EventStream.tsx         # event list for debug panel
        EventRow.tsx            # single event with expand
      onboarding/
        OnboardingWizard.tsx    # 4-step setup
        StepAgent.tsx
        StepEnvironment.tsx
        StepSecrets.tsx
        StepReady.tsx
      shared/
        CommandPalette.tsx      # Cmd+K
    hooks/
      use-api.ts               # fetch wrapper with x-api-key header
      use-sse.ts               # SSE connection with reconnect
      use-sessions.ts          # TanStack Query hook
      use-agents.ts
      use-environments.ts
      use-vaults.ts
      use-events.ts
    stores/
      app-store.ts             # Zustand: activeSessionId, UI state
    lib/
      api-client.ts            # typed fetch wrapper
      constants.ts             # models, providers, engine configs
    index.css                  # Tailwind base + shadcn theme (dark, lime accent)
```

## Build & Embedding

### Pipeline

```
npm run build:ui
  1. cd packages/gateway-ui && vite build
     -> produces dist/index.html (single file, all JS/CSS inlined, ~200-300KB)
  2. scripts/build-ui.ts reads dist/index.html
     -> escapes backticks and ${} for template literal safety
     -> generates MD5 hash for ETag
     -> writes packages/agent-sdk/src/handlers/ui.ts
  3. cd packages/gateway && node build.js
     -> esbuild bundles ui.ts as before into dist/gateway.js
```

### Key Constraints

- `handleGetUI({ apiKey })` signature and behavior must be preserved
- The `__INJECT__` placeholder pattern for runtime API key injection must be maintained
- No additional HTTP routes needed — the UI is still a single `GET /` response
- The generated `ui.ts` is committed to git (same as today)

### Bundle Size

- Current: ~80KB inlined HTML
- Expected: ~200-300KB inlined HTML (React + shadcn + Tailwind purged)
- Gateway bundle impact: +150-200KB on a 6.4MB bundle (~3% increase)

## API Surface (unchanged)

The new UI calls the same `/v1/` endpoints:

- `GET/POST/PATCH/DELETE /v1/agents` — CRUD
- `GET/POST/DELETE /v1/environments` — CRUD
- `GET/POST/DELETE /v1/sessions` — CRUD
- `GET/POST /v1/sessions/:id/events` — list/create events
- `GET /v1/sessions/:id/stream` — SSE stream
- `GET/POST/DELETE /v1/vaults` — CRUD
- `GET/PUT/DELETE /v1/vaults/:id/entries/:key` — entry CRUD

No backend changes required.

## Theme

- Dark mode only (matches current UI)
- Accent color: lime/chartreuse (#a3e635, Tailwind `lime-400`) — carried from current theme
- Font: Inter (self-hosted via Tailwind, no CDN dependency)
- shadcn "new-york" style variant

## Verification

1. `cd packages/gateway-ui && npm run dev` — Vite dev server on :5173 with hot reload, proxying `/v1/*` requests to gateway on :4000 (configured in `vite.config.ts` server.proxy)
2. `npm run build:ui` — full pipeline: Vite build -> build-ui.ts -> ui.ts generated
3. `cd packages/gateway && node build.js` — verify esbuild bundles successfully
4. `node packages/gateway/dist/gateway.js serve` — verify UI loads at localhost:4000
5. Functional checks:
   - Create agent via onboarding wizard
   - Create environment
   - Create session and send a message
   - Verify SSE streaming works (typing indicator, messages appear)
   - Open agent popover from session header
   - Toggle debug panel, verify events stream
   - Open settings drawer, manage vaults
   - Cmd+K palette works
   - Cancel buttons work in all dialogs
