# UI Redesign Phase 1: Router + Navigation + Resource Pages

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat-first UI with a developer API console — resource-first left nav, TanStack Router, standalone resource pages, Overview home page.

**Architecture:** Install TanStack Router to replace the Zustand boolean routing. Build a new `ConsoleNav` left sidebar with section groups (Overview, Resources, Tools). Promote existing Settings tab components (AgentsTab, EnvironmentsTab, etc.) to standalone route pages. Build an Overview home page with stats + getting started + activity. Replace the Hono per-route SPA entries with a single wildcard catch-all.

**Tech Stack:** TanStack Router, React, shadcn/ui, Tailwind v4, Zustand (stripped of routing, kept for non-routing state)

---

## File Structure

```
packages/gateway-ui/src/
  router.tsx                          — CREATE: TanStack Router route tree
  routes/
    __root.tsx                        — CREATE: Root layout with ConsoleNav
    index.tsx                         — CREATE: Home/Overview page
    agents.tsx                        — CREATE: Agents list page (wraps AgentsTab)
    agents.$id.tsx                    — CREATE: Agent detail page (wraps AgentDetailPage)
    environments.tsx                  — CREATE: Environments list page
    sessions.tsx                      — CREATE: Sessions list page (NEW)
    sessions.$id.tsx                  — CREATE: Session detail page (NEW)
    secrets.tsx                       — CREATE: Secrets/Vaults page (wraps VaultsTab)
    files.tsx                         — CREATE: Files + Repos page (wraps ResourcesTab)
    skills.tsx                        — CREATE: Skills catalog page (NEW)
    memory.tsx                        — CREATE: Memory stores page (wraps MemoryStoresTab)
    playground.tsx                    — CREATE: Placeholder (Phase 2)
    dashboard.tsx                     — CREATE: Dashboard page (wraps DashboardPage)
    docs.tsx                          — CREATE: API Docs iframe (Phase 2)
    api-keys.tsx                      — CREATE: API Keys page (Phase 2)
    quickstart.tsx                    — CREATE: Quick Start wizard
  components/
    console-nav/
      ConsoleNav.tsx                  — CREATE: New left nav sidebar
      NavSection.tsx                  — CREATE: Section group (Overview, Resources, Tools)
      NavItem.tsx                     — CREATE: Single nav item with active state
    pages/
      OverviewPage.tsx                — CREATE: Stats + getting started + activity
      SessionsPage.tsx               — CREATE: Sessions list with table
      SessionDetailPage.tsx           — CREATE: Session detail with events/traces
      SkillsPage.tsx                  — CREATE: Skills catalog (promoted from tab)
  stores/app-store.ts                 — MODIFY: Remove routing booleans, keep non-routing state
  App.tsx                             — MODIFY: Replace conditional rendering with RouterProvider
  main.tsx                            — MODIFY: Add router setup

packages/gateway-hono/src/
  index.ts                            — MODIFY: Replace per-route serveUI with wildcard catch-all
```

---

### Task 1: Install TanStack Router

**Files:**
- Modify: `packages/gateway-ui/package.json`

- [ ] **Step 1: Install TanStack Router**

```bash
cd packages/gateway-ui && npm install @tanstack/react-router
```

- [ ] **Step 2: Verify install**

```bash
node -e "require('@tanstack/react-router')" 2>&1 || echo "ESM module — OK"
```

- [ ] **Step 3: Commit**

```bash
git add packages/gateway-ui/package.json package-lock.json
git commit -m "chore: install @tanstack/react-router"
```

---

### Task 2: Create Route Tree + Root Layout

**Files:**
- Create: `packages/gateway-ui/src/router.tsx`
- Create: `packages/gateway-ui/src/routes/__root.tsx`

- [ ] **Step 1: Create the router with route tree**

```tsx
// packages/gateway-ui/src/router.tsx
import { createRouter, createRoute, createRootRoute } from "@tanstack/react-router";
import { RootLayout } from "./routes/__root";

// Root route — wraps all pages with ConsoleNav
const rootRoute = createRootRoute({
  component: RootLayout,
});

// Page routes — lazy-loaded components will be added per task
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
const agentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agents" });
const agentDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/agents/$id" });
const environmentsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/environments" });
const sessionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/sessions" });
const sessionDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/sessions/$id" });
const secretsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/secrets" });
const filesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/files" });
const skillsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/skills" });
const memoryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/memory" });
const playgroundRoute = createRoute({ getParentRoute: () => rootRoute, path: "/playground" });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/dashboard" });
const docsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/docs" });
const apiKeysRoute = createRoute({ getParentRoute: () => rootRoute, path: "/api-keys" });
const quickstartRoute = createRoute({ getParentRoute: () => rootRoute, path: "/quickstart" });

const routeTree = rootRoute.addChildren([
  indexRoute,
  agentsRoute,
  agentDetailRoute,
  environmentsRoute,
  sessionsRoute,
  sessionDetailRoute,
  secretsRoute,
  filesRoute,
  skillsRoute,
  memoryRoute,
  playgroundRoute,
  dashboardRoute,
  docsRoute,
  apiKeysRoute,
  quickstartRoute,
]);

export const router = createRouter({ routeTree });

// Export routes for lazy component assignment
export {
  indexRoute,
  agentsRoute,
  agentDetailRoute,
  environmentsRoute,
  sessionsRoute,
  sessionDetailRoute,
  secretsRoute,
  filesRoute,
  skillsRoute,
  memoryRoute,
  playgroundRoute,
  dashboardRoute,
  docsRoute,
  apiKeysRoute,
  quickstartRoute,
};
```

- [ ] **Step 2: Create root layout with placeholder nav**

```tsx
// packages/gateway-ui/src/routes/__root.tsx
import { Outlet } from "@tanstack/react-router";

export function RootLayout() {
  return (
    <div className="flex h-screen">
      <nav className="w-56 shrink-0 border-r border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">Nav placeholder</p>
      </nav>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/gateway-ui/src/router.tsx packages/gateway-ui/src/routes/
git commit -m "feat: TanStack Router route tree + root layout"
```

---

### Task 3: Wire Router into App + Main

**Files:**
- Modify: `packages/gateway-ui/src/App.tsx`
- Modify: `packages/gateway-ui/src/main.tsx`

- [ ] **Step 1: Replace App.tsx with RouterProvider**

Replace the entire `App.tsx` content. The old conditional rendering (`dashboardOpen ? <DashboardPage /> : settingsOpen ? <SettingsPage /> : <Main />`) is replaced by the router.

```tsx
// packages/gateway-ui/src/App.tsx
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5000, refetchOnWindowFocus: true } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 2: Assign placeholder components to routes**

In `router.tsx`, add component assignments to each route. For now, all pages render a placeholder:

```tsx
// Add to each route definition:
indexRoute.update({ component: () => <div className="p-8"><h1 className="text-lg font-semibold text-foreground">Home</h1><p className="text-muted-foreground">Overview coming soon</p></div> });
agentsRoute.update({ component: () => <div className="p-8"><h1 className="text-lg font-semibold text-foreground">Agents</h1></div> });
// ... etc for all routes
```

Actually, TanStack Router requires components at route creation time. Let me use inline components:

Update router.tsx — replace each `createRoute` with a component:

```tsx
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <div className="p-8"><h1 className="text-lg font-semibold text-foreground">Home</h1><p className="text-sm text-muted-foreground">Overview coming soon</p></div>,
});
```

Repeat for all routes with simple placeholder text.

- [ ] **Step 3: Verify Vite build passes**

```bash
cd packages/gateway-ui && npx vite build
```

- [ ] **Step 4: Commit**

```bash
git add packages/gateway-ui/src/App.tsx packages/gateway-ui/src/router.tsx
git commit -m "feat: wire TanStack Router into App, placeholder pages"
```

---

### Task 4: Build ConsoleNav Component

**Files:**
- Create: `packages/gateway-ui/src/components/console-nav/ConsoleNav.tsx`
- Create: `packages/gateway-ui/src/components/console-nav/NavItem.tsx`
- Modify: `packages/gateway-ui/src/routes/__root.tsx`

- [ ] **Step 1: Create NavItem component**

```tsx
// packages/gateway-ui/src/components/console-nav/NavItem.tsx
import { Link, useMatchRoute } from "@tanstack/react-router";

interface Props {
  to: string;
  label: string;
  icon?: React.ReactNode;
}

export function NavItem({ to, label, icon }: Props) {
  const matchRoute = useMatchRoute();
  const isActive = matchRoute({ to, fuzzy: true });

  return (
    <Link
      to={to}
      className={`flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
        isActive
          ? "bg-lime-400/10 text-foreground font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
    >
      {icon && <span className="size-4 shrink-0">{icon}</span>}
      {label}
    </Link>
  );
}
```

- [ ] **Step 2: Create ConsoleNav component**

```tsx
// packages/gateway-ui/src/components/console-nav/ConsoleNav.tsx
import {
  Home, Key, Bot, Server, MessageSquare, Lock, FileText,
  Sparkles, Brain, Play, BarChart3, BookOpen, Sun, Moon,
} from "lucide-react";
import { NavItem } from "./NavItem";

export function ConsoleNav() {
  return (
    <nav className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-card">
      {/* Logo */}
      <div className="flex items-center gap-1.5 px-4 py-4">
        <span className="size-2 rounded-full bg-lime-400 shadow-[0_0_8px_2px_rgba(163,230,53,0.6),0_0_20px_4px_rgba(163,230,53,0.3)] shrink-0" />
        <span className="font-semibold tracking-tight font-mono text-[15px] text-foreground">agentstep</span>
      </div>

      {/* Nav sections */}
      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-4">
        <Section label="Overview">
          <NavItem to="/" label="Home" icon={<Home className="size-4" />} />
          <NavItem to="/api-keys" label="API Keys" icon={<Key className="size-4" />} />
        </Section>

        <Section label="Resources">
          <NavItem to="/agents" label="Agents" icon={<Bot className="size-4" />} />
          <NavItem to="/environments" label="Environments" icon={<Server className="size-4" />} />
          <NavItem to="/sessions" label="Sessions" icon={<MessageSquare className="size-4" />} />
          <NavItem to="/secrets" label="Secrets" icon={<Lock className="size-4" />} />
          <NavItem to="/files" label="Files" icon={<FileText className="size-4" />} />
          <NavItem to="/skills" label="Skills" icon={<Sparkles className="size-4" />} />
          <NavItem to="/memory" label="Memory" icon={<Brain className="size-4" />} />
        </Section>

        <Section label="Tools">
          <NavItem to="/playground" label="Playground" icon={<Play className="size-4" />} />
          <NavItem to="/dashboard" label="Dashboard" icon={<BarChart3 className="size-4" />} />
          <NavItem to="/docs" label="API Docs" icon={<BookOpen className="size-4" />} />
        </Section>
      </div>

      {/* Footer */}
      <div className="border-t border-border px-4 py-3 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground/50">
          {window.__MA_VERSION__ ? `v${window.__MA_VERSION__}` : ""}
        </span>
        <button
          onClick={() => document.documentElement.classList.toggle("dark")}
          className="text-muted-foreground hover:text-foreground"
        >
          <Sun className="size-3.5 rotate-0 scale-100 transition-transform dark:rotate-90 dark:scale-0" />
          <Moon className="absolute size-3.5 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
        </button>
      </div>
    </nav>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40">
        {label}
      </p>
      <div className="flex flex-col gap-0.5">
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update root layout to use ConsoleNav**

```tsx
// packages/gateway-ui/src/routes/__root.tsx
import { Outlet } from "@tanstack/react-router";
import { ConsoleNav } from "@/components/console-nav/ConsoleNav";

export function RootLayout() {
  return (
    <div className="flex h-screen bg-background">
      <ConsoleNav />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Verify build + commit**

```bash
cd packages/gateway-ui && npx vite build
git add packages/gateway-ui/src/components/console-nav/ packages/gateway-ui/src/routes/__root.tsx
git commit -m "feat: ConsoleNav left sidebar with resource-first navigation"
```

---

### Task 5: Promote Resource Pages from Settings Tabs

**Files:**
- Modify: `packages/gateway-ui/src/router.tsx` — assign real components to routes

- [ ] **Step 1: Wire existing tab components as route pages**

Update each route in `router.tsx` to render the existing tab component wrapped in a page container:

```tsx
// In router.tsx, import and assign:
import { AgentsTab } from "@/components/settings/AgentsTab";
import { AgentDetailPage } from "@/components/settings/AgentDetailPage";
import { EnvironmentsTab } from "@/components/settings/EnvironmentsTab";
import { VaultsTab } from "@/components/settings/VaultsTab";
import { MemoryStoresTab } from "@/components/settings/MemoryStoresTab";
import { ResourcesTab } from "@/components/settings/ResourcesTab";
import { DashboardPage } from "@/components/dashboard/DashboardPage";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";

// Page wrapper — adds consistent padding/max-width
function PageWrapper({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-5xl px-6 py-6">{children}</div>;
}

// Update route components:
const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: () => <PageWrapper><AgentsTab /></PageWrapper>,
});

const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$id",
  component: function AgentDetail() {
    const { id } = agentDetailRoute.useParams();
    // AgentDetailPage reads from store — set the ID
    const store = useAppStore.getState();
    if (store.selectedAgentId !== id) store.setSelectedAgentId(id);
    return <AgentDetailPage />;
  },
});

const environmentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/environments",
  component: () => <PageWrapper><EnvironmentsTab /></PageWrapper>,
});

const secretsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/secrets",
  component: () => <PageWrapper><VaultsTab /></PageWrapper>,
});

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/files",
  component: () => <PageWrapper><ResourcesTab /></PageWrapper>,
});

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/memory",
  component: () => <PageWrapper><MemoryStoresTab /></PageWrapper>,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: DashboardPage,
});

const quickstartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/quickstart",
  component: () => (
    <div className="flex flex-1 items-center justify-center p-8">
      <OnboardingWizard />
    </div>
  ),
});
```

- [ ] **Step 2: Build and verify all pages render**

```bash
cd packages/gateway-ui && npx vite build
```

- [ ] **Step 3: Commit**

```bash
git add packages/gateway-ui/src/router.tsx
git commit -m "feat: promote settings tabs to standalone route pages"
```

---

### Task 6: Build Overview Home Page

**Files:**
- Create: `packages/gateway-ui/src/components/pages/OverviewPage.tsx`
- Modify: `packages/gateway-ui/src/router.tsx`

- [ ] **Step 1: Create OverviewPage**

Two-column layout: stats + activity on left, getting started + quick actions on right.

```tsx
// packages/gateway-ui/src/components/pages/OverviewPage.tsx
import { Link } from "@tanstack/react-router";
import { Bot, Server, MessageSquare, Zap, Play, Plus } from "lucide-react";
import { useAgents } from "@/hooks/use-agents";
import { useSessions } from "@/hooks/use-sessions";
import { useEnvironments } from "@/hooks/use-environments";

function timeAgo(ts: number | string): string {
  const ms = typeof ts === "string" ? new Date(ts).getTime() : ts;
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function OverviewPage() {
  const { data: agents } = useAgents();
  const { data: sessions } = useSessions();
  const { data: environments } = useEnvironments();

  const activeSessions = sessions?.filter(s => s.status === "running") ?? [];
  const recentSessions = sessions?.slice(0, 10) ?? [];

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <h1 className="text-xl font-semibold text-foreground mb-6">Overview</h1>

      <div className="grid grid-cols-3 gap-6">
        {/* Left column — stats + activity */}
        <div className="col-span-2 flex flex-col gap-6">
          {/* Stats bar */}
          <div className="grid grid-cols-4 gap-3">
            <StatCard icon={<Bot className="size-4" />} label="Agents" value={agents?.length ?? 0} />
            <StatCard icon={<Server className="size-4" />} label="Environments" value={environments?.length ?? 0} />
            <StatCard icon={<MessageSquare className="size-4" />} label="Active Sessions" value={activeSessions.length} />
            <StatCard icon={<Zap className="size-4" />} label="Total Sessions" value={sessions?.length ?? 0} />
          </div>

          {/* Recent activity */}
          <div>
            <h2 className="text-sm font-medium text-foreground mb-3">Recent Activity</h2>
            {recentSessions.length > 0 ? (
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="text-left px-4 py-2 font-medium">Session</th>
                      <th className="text-left px-4 py-2 font-medium">Status</th>
                      <th className="text-left px-4 py-2 font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentSessions.map(s => (
                      <tr key={s.id} className="border-b border-border/50 last:border-0">
                        <td className="px-4 py-2">
                          <Link to={`/sessions/${s.id}`} className="text-foreground hover:text-lime-400 transition-colors">
                            {s.title || s.id.slice(0, 16)}
                          </Link>
                        </td>
                        <td className="px-4 py-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            s.status === "running"
                              ? "bg-lime-400/15 text-lime-400"
                              : "bg-muted text-muted-foreground"
                          }`}>
                            {s.status}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-muted-foreground text-xs">
                          {timeAgo(s.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-8 text-center border border-dashed border-border rounded-lg">
                No sessions yet. Create an agent and start a session.
              </p>
            )}
          </div>
        </div>

        {/* Right column — getting started + quick actions */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-foreground">Quick Actions</h2>
          <QuickAction to="/agents" icon={<Plus className="size-4" />} label="Create Agent" description="Configure a new AI agent" />
          <QuickAction to="/environments" icon={<Server className="size-4" />} label="Add Environment" description="Set up a container provider" />
          <QuickAction to="/playground" icon={<Play className="size-4" />} label="Open Playground" description="Test agents interactively" />
          <QuickAction to="/quickstart" icon={<Zap className="size-4" />} label="Quick Start" description="Set up everything in one flow" />

          {/* API Key */}
          <div className="rounded-lg border border-border p-3 mt-2">
            <p className="text-xs text-muted-foreground mb-1">API Key</p>
            <code className="text-xs font-mono text-foreground break-all">
              {window.__MA_API_KEY__ || "Not configured"}
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}

function QuickAction({ to, icon, label, description }: { to: string; icon: React.ReactNode; label: string; description: string }) {
  return (
    <Link
      to={to}
      className="flex items-start gap-3 rounded-lg border border-border p-3 hover:border-muted-foreground/50 transition-colors"
    >
      <div className="text-lime-400 mt-0.5">{icon}</div>
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: Wire into router**

```tsx
import { OverviewPage } from "@/components/pages/OverviewPage";

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
});
```

- [ ] **Step 3: Build + commit**

```bash
cd packages/gateway-ui && npx vite build
git add packages/gateway-ui/src/components/pages/OverviewPage.tsx packages/gateway-ui/src/router.tsx
git commit -m "feat: Overview home page with stats, activity, quick actions"
```

---

### Task 7: Build Sessions Resource Page

**Files:**
- Create: `packages/gateway-ui/src/components/pages/SessionsPage.tsx`
- Create: `packages/gateway-ui/src/components/pages/SessionDetailPage.tsx`

- [ ] **Step 1: Create SessionsPage (list view)**

Table with: title, agent, environment, status, created, stop_reason. Reuses `useAgents()` and `useEnvironments()` for lookups.

```tsx
// packages/gateway-ui/src/components/pages/SessionsPage.tsx
import { Link } from "@tanstack/react-router";
import { useSessions } from "@/hooks/use-sessions";
import { useAgents } from "@/hooks/use-agents";
import { useEnvironments } from "@/hooks/use-environments";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/settings/PageHeader";

export function SessionsPage() {
  const { data: sessions } = useSessions();
  const { data: agents } = useAgents();
  const { data: environments } = useEnvironments();

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <PageHeader title="Sessions" description="View and manage agent sessions." />

      {sessions && sessions.length > 0 ? (
        <div className="rounded-lg border border-border mt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Environment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map(s => {
                const agent = agents?.find(a => a.id === s.agent?.id);
                const env = environments?.find(e => e.id === s.environment_id);
                return (
                  <TableRow key={s.id} className="cursor-pointer">
                    <TableCell>
                      <Link to={`/sessions/${s.id}`} className="text-foreground hover:text-lime-400">
                        {s.title || s.id.slice(0, 16)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{agent?.name || "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{env?.name || "—"}</TableCell>
                    <TableCell>
                      <Badge variant={s.status === "running" ? "default" : "outline"} className={s.status === "running" ? "bg-lime-400/15 text-lime-400 border-lime-400/20" : ""}>
                        {s.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(s.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">No sessions yet.</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create SessionDetailPage**

Shows session metadata + events list. Reuses existing `EventStream` component.

```tsx
// packages/gateway-ui/src/components/pages/SessionDetailPage.tsx
import { useParams, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/use-sessions";
import { useEvents } from "@/hooks/use-events";
import { useAgent } from "@/hooks/use-agents";
import { EventStream } from "@/components/events/EventStream";
import { useSSE } from "@/hooks/use-sse";

export function SessionDetailPage() {
  const { id } = useParams({ from: "/sessions/$id" });
  const { data: session } = useSession(id);
  const { data: agent } = useAgent(session?.agent?.id ?? null);
  useSSE(id);

  if (!session) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 border-b px-6 py-3">
        <Link to="/sessions">
          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-foreground">{session.title || session.id.slice(0, 20)}</h2>
          <p className="text-xs text-muted-foreground">{agent?.name || "Agent"} · {session.status}</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <EventStream sessionId={id} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire into router + build + commit**

```bash
git add packages/gateway-ui/src/components/pages/SessionsPage.tsx packages/gateway-ui/src/components/pages/SessionDetailPage.tsx packages/gateway-ui/src/router.tsx
git commit -m "feat: Sessions resource page with list and detail views"
```

---

### Task 8: Hono Wildcard SPA Catch-All

**Files:**
- Modify: `packages/gateway-hono/src/index.ts`

- [ ] **Step 1: Replace per-route serveUI with wildcard**

Remove:
```ts
app.get("/", serveUI);
app.get("/settings", serveUI);
app.get("/settings/agents/:id", serveUI);
app.get("/sessions/:id", serveUI);
app.get("/dashboard", serveUI);
```

Replace with a single catch-all at the END of the file (before `export default app`):

```ts
// ── SPA catch-all (must be last) ────────────────────────────────────
// Serve the UI for any path that isn't an API route
app.get("*", (c) => {
  const path = c.req.path;
  if (path.startsWith("/v1/") || path.startsWith("/api/")) {
    return c.json({ error: { type: "not_found_error", message: "Not found" } }, 404);
  }
  return serveUI();
});
```

- [ ] **Step 2: Build gateway + commit**

```bash
cd packages/gateway && node build.js
git add packages/gateway-hono/src/index.ts
git commit -m "feat: SPA wildcard catch-all replaces per-route serveUI"
```

---

### Task 9: Clean Up Old Routing

**Files:**
- Modify: `packages/gateway-ui/src/stores/app-store.ts` — strip routing state
- Delete: `packages/gateway-ui/src/components/settings/SettingsPage.tsx` (no longer needed)
- Delete: `packages/gateway-ui/src/components/app-sidebar.tsx` (replaced by ConsoleNav)

- [ ] **Step 1: Strip routing booleans from app-store**

Keep: `apiKey`, `debugOpen`, `commandOpen`, `dashboardWindowMinutes`
Remove: `settingsOpen`, `setSettingsOpen`, `selectedAgentId`, `setSelectedAgentId`, `activeSessionId`, `setActiveSessionId`, `dashboardOpen`, `setDashboardOpen`, `sidebarOpen`, `setSidebarOpen`
Remove: `getInitialRoute()`, `popstate` listener

The Zustand store becomes purely non-routing state:

```ts
import { create } from "zustand";

interface AppState {
  apiKey: string;
  setApiKey: (key: string) => void;
  debugOpen: boolean;
  toggleDebug: () => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  dashboardWindowMinutes: number;
  setDashboardWindowMinutes: (m: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
  apiKey: window.__MA_API_KEY__ || localStorage.getItem("ma-api-key") || "",
  setApiKey: (key) => {
    localStorage.setItem("ma-api-key", key);
    set({ apiKey: key });
  },
  debugOpen: false,
  toggleDebug: () => set((s) => ({ debugOpen: !s.debugOpen })),
  commandOpen: false,
  setCommandOpen: (open) => set({ commandOpen: open }),
  dashboardWindowMinutes: 60,
  setDashboardWindowMinutes: (m) => set({ dashboardWindowMinutes: m }),
}));
```

- [ ] **Step 2: Update all components that import removed store properties**

Components like `ChatInput`, `ChatThread`, `SessionItem`, `SessionHeader` use `activeSessionId` and `setActiveSessionId`. These need to switch to TanStack Router's `useParams()` and `useNavigate()`:

- `useAppStore(s => s.activeSessionId)` → `useParams({ from: "/playground/$sessionId" })` or route-specific
- `setActiveSessionId(id)` → `navigate({ to: "/playground/$sessionId", params: { sessionId: id } })`
- `setSettingsOpen(true)` → `navigate({ to: "/agents" })`
- `setDashboardOpen(true)` → `navigate({ to: "/dashboard" })`

This is the largest migration step — many files reference the old store routing.

- [ ] **Step 3: Build + fix all import errors + commit**

```bash
cd packages/gateway-ui && npx vite build
# Fix any compile errors from removed store properties
git add -A
git commit -m "refactor: strip routing from Zustand store, migrate to TanStack Router navigation"
```

---

### Task 10: Full Build + Test

- [ ] **Step 1: Rebuild everything**

```bash
cd packages/gateway-ui && npx vite build
cd ../.. && npx tsx scripts/build-ui.ts
cd packages/gateway && node build.js
```

- [ ] **Step 2: Start server and verify**

```bash
node packages/gateway/dist/gateway.js serve --port 4111
```

Verify:
- `/` → Overview page with stats
- `/agents` → Agents list
- `/agents/:id` → Agent detail
- `/environments` → Environments list
- `/sessions` → Sessions list
- `/secrets` → Vaults/Secrets
- `/files` → Files + Repos
- `/memory` → Memory stores
- `/dashboard` → Metrics dashboard
- `/playground` → Placeholder (Phase 2)
- `/quickstart` → Wizard
- Browser back/forward works
- Direct URL access works

- [ ] **Step 3: Run tests**

```bash
npx vitest run
cd packages/gateway-ui && npx playwright test
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: Phase 1 complete — developer console with resource-first navigation"
```

---

## Verification

1. Left nav shows all sections: Overview, Resources (7 items), Tools (3 items)
2. Each nav item navigates to correct page
3. Resource pages show existing data (agents, environments, etc.)
4. Overview shows stats, recent activity, quick actions
5. Sessions page shows list with click-through to detail
6. Browser back/forward works
7. Direct URL bookmarks work
8. Old Settings page and sidebar are gone
9. Build passes
10. All existing API tests still pass
