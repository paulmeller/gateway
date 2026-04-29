import { useState, useEffect } from "react";
import { createRouter, createRoute, createRootRoute, redirect, Outlet, useRouterState, useNavigate } from "@tanstack/react-router";
import { SkipForward } from "lucide-react";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { useAgents } from "@/hooks/use-agents";
import { useEnvironments } from "@/hooks/use-environments";
import { useSessions } from "@/hooks/use-sessions";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { AppSidebarLeft } from "@/components/app-sidebar-left";
import { AgentsTab } from "@/components/settings/AgentsTab";
import { AgentDetailPage } from "@/components/settings/AgentDetailPage";
import { EnvironmentsTab } from "@/components/settings/EnvironmentsTab";
import { VaultsTab } from "@/components/settings/VaultsTab";
import { FilesPanel, RepositoriesSection } from "@/components/settings/ResourcesTab";
import { MemoryStoresTab } from "@/components/settings/MemoryStoresTab";
import { TenantsTab } from "@/components/settings/TenantsTab";
import { DashboardPage } from "@/components/dashboard/DashboardPage";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { OverviewPage } from "@/components/pages/OverviewPage";
import { SessionsPage } from "@/components/pages/SessionsPage";
import { SessionDetailPage } from "@/components/pages/SessionDetailPage";
import { PlaygroundPage } from "@/components/pages/PlaygroundPage";
import { SkillsPage } from "@/components/pages/SkillsPage";
import { ApiKeysPage } from "@/components/pages/ApiKeysPage";
import { DocsPage } from "@/components/pages/DocsPage";
import { useAppStore } from "@/stores/app-store";

// ─── Root ────────────────────────────────────────────────────────────────────

function RootLayout() {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "d") {
        e.preventDefault();
        useAppStore.getState().toggleDebug();
      }
      if (meta && e.key === "k") {
        e.preventDefault();
        useAppStore.getState().setCommandOpen(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <SidebarProvider>
      <AppSidebarLeft />
      <SidebarInset>
        <header className="relative flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1 text-muted-foreground" />
          <Separator orientation="vertical" className="mr-2 !self-center h-4" />
          <PageBreadcrumb />
          <NavbarCenter />
          <div className="flex-1" />
          <div id="navbar-actions" className="flex items-center gap-2" />
          <SkipOnboardingButton />
        </header>
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

const PAGE_TITLES: Record<string, string> = {
  "/": "Home",
  "/api-keys": "API Keys",
  "/tenants": "Tenants",
  "/agents": "Agents",
  "/environments": "Environments",
  "/sessions": "Sessions",
  "/secrets": "Secrets",
  "/files": "Files",
  "/skills": "Skills",
  "/memory": "Memory",
  "/playground": "Playground",
  "/analytics": "Analytics",
  "/docs": "API Docs",
  "/quickstart": "Quick Start",
};

function PageBreadcrumb() {
  const routerState = useRouterState();
  const path = routerState.location.pathname;
  const basePath = "/" + (path.split("/")[1] || "");
  const title = PAGE_TITLES[basePath] || basePath.slice(1);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbPage className="text-sm font-medium text-foreground">
            {title}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * Route-aware center slot in the navbar. Only renders content for
 * routes that need sub-navigation (currently: /dashboard tabs).
 * On all other routes this returns null — the header stays clean.
 */
function NavbarCenter() {
  const routerState = useRouterState();
  const path = routerState.location.pathname;
  if (path === "/analytics") return <DashboardNavTabs />;
  if (path === "/files") return <FilesNavTabs />;
  return null;
}

const DASHBOARD_TABS = [
  { value: "agents", label: "Agent Activity" },
  { value: "api", label: "API Throughput" },
] as const;

function DashboardNavTabs() {
  const routerState = useRouterState();
  const params = new URLSearchParams(routerState.location.searchStr);
  const activeTab = params.get("tab") === "api" ? "api" : "agents";
  const nav = useNavigate();
  return (
    <div className="absolute inset-x-0 flex justify-center pointer-events-none">
      <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5 pointer-events-auto">
        {DASHBOARD_TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => nav({ to: "/analytics", search: { tab: t.value } as never, replace: true })}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              activeTab === t.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const FILES_TABS = [
  { value: "files", label: "Files" },
  { value: "repos", label: "Repositories" },
] as const;

function FilesNavTabs() {
  const routerState = useRouterState();
  const params = new URLSearchParams(routerState.location.searchStr);
  const activeTab = params.get("tab") === "repos" ? "repos" : "files";
  const nav = useNavigate();
  return (
    <div className="absolute inset-x-0 flex justify-center pointer-events-none">
      <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5 pointer-events-auto">
        {FILES_TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => nav({ to: "/files", search: { tab: t.value } as never, replace: true })}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              activeTab === t.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const HERO_DISMISSED_KEY = "as.hero_dismissed";

function SkipOnboardingButton() {
  const routerState = useRouterState();
  const isHome = routerState.location.pathname === "/";
  const agentsQ = useAgents();
  const envsQ = useEnvironments();
  const sessionsQ = useSessions();

  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(HERO_DISMISSED_KEY) === "1",
  );

  // Listen for storage changes (in case another tab dismisses)
  useEffect(() => {
    const handler = () => setDismissed(localStorage.getItem(HERO_DISMISSED_KEY) === "1");
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const allLoaded = !agentsQ.isPending && !envsQ.isPending && !sessionsQ.isPending;
  const anyError = agentsQ.isError || envsQ.isError || sessionsQ.isError;
  const isEmpty = allLoaded && !anyError
    && (agentsQ.data?.length ?? 0) === 0
    && (envsQ.data?.length ?? 0) === 0
    && (sessionsQ.data?.length ?? 0) === 0;

  // Only show on home when hero is visible
  if (!isHome || !isEmpty || dismissed) return null;

  return (
    <button
      onClick={() => {
        localStorage.setItem(HERO_DISMISSED_KEY, "1");
        setDismissed(true);
        // Nudge storage listeners in same tab
        window.dispatchEvent(new StorageEvent("storage", { key: HERO_DISMISSED_KEY }));
      }}
      className="ml-auto inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors"
      title="Skip the welcome screen"
    >
      <SkipForward className="size-3.5" />
      Skip onboarding
    </button>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
});

// ─── Wrapper helper ──────────────────────────────────────────────────────────

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">{children}</div>
  );
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: function AgentsPage() {
    return (
      <Page>
        <AgentsTab />
      </Page>
    );
  },
});

const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/$id",
  component: function AgentDetailRoute() {
    const { id } = agentDetailRoute.useParams();

    useEffect(() => {
      useAppStore.getState().setSelectedAgentId(id);
      return () => {
        // don't clear on unmount — AgentDetailPage reads from store
      };
    }, [id]);

    return <AgentDetailPage />;
  },
});

const environmentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/environments",
  component: function EnvironmentsPage() {
    return (
      <Page>
        <EnvironmentsTab />
      </Page>
    );
  },
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: SessionsPage,
});

export const sessionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$id",
  component: function SessionDetailRoute() {
    const { id } = sessionDetailRoute.useParams();
    return <SessionDetailPage id={id} />;
  },
});

const secretsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/secrets",
  component: function SecretsPage() {
    return (
      <Page>
        <VaultsTab />
      </Page>
    );
  },
});

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/files",
  component: function FilesPage() {
    const routerState = useRouterState();
    const params = new URLSearchParams(routerState.location.searchStr);
    const tab = params.get("tab") === "repos" ? "repos" : "files";
    return (
      <Page>
        {tab === "files" ? <FilesPanel /> : <RepositoriesSection />}
      </Page>
    );
  },
});

const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/skills",
  component: SkillsPage,
});

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/memory",
  component: function MemoryPage() {
    return (
      <Page>
        <MemoryStoresTab />
      </Page>
    );
  },
});

const playgroundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/playground",
  beforeLoad: () => {
    throw redirect({ to: "/quickstart" });
  },
});

const playgroundSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/playground/$sessionId",
  component: function PlaygroundSessionRoute() {
    const { sessionId } = playgroundSessionRoute.useParams();
    return <PlaygroundPage sessionId={sessionId} />;
  },
});

type DashboardSearch = { tab: "agents" | "api" };

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/analytics",
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    tab: search.tab === "api" ? "api" : "agents",
  }),
  component: DashboardPage,
});

const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs",
  component: DocsPage,
});

const apiKeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/api-keys",
  component: ApiKeysPage,
});

const tenantsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tenants",
  component: function TenantsPage() {
    return (
      <Page>
        <TenantsTab />
      </Page>
    );
  },
});

const quickstartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/quickstart",
  component: OnboardingWizard,
});

// ─── Route tree ───────────────────────────────────────────────────────────────

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
  playgroundSessionRoute,
  dashboardRoute,
  docsRoute,
  apiKeysRoute,
  tenantsRoute,
  quickstartRoute,
]);

// ─── Router ───────────────────────────────────────────────────────────────────

export const router = createRouter({
  routeTree,
  basepath: (window as unknown as { __BASE_PATH__?: string }).__BASE_PATH__ || "/",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
