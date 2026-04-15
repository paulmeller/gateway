import { createRouter, createRoute, createRootRoute, redirect, Outlet, useRouterState } from "@tanstack/react-router";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
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
import { ResourcesTab } from "@/components/settings/ResourcesTab";
import { MemoryStoresTab } from "@/components/settings/MemoryStoresTab";
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
import { useEffect } from "react";

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
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1 text-muted-foreground" />
          <Separator orientation="vertical" className="mr-2 !self-center h-4" />
          <PageBreadcrumb />
        </header>
        <div className="flex flex-1 flex-col overflow-y-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

const PAGE_TITLES: Record<string, string> = {
  "/": "Home",
  "/api-keys": "API Keys",
  "/agents": "Agents",
  "/environments": "Environments",
  "/sessions": "Sessions",
  "/secrets": "Secrets",
  "/files": "Files",
  "/skills": "Skills",
  "/memory": "Memory",
  "/playground": "Playground",
  "/dashboard": "Analytics",
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

const rootRoute = createRootRoute({
  component: RootLayout,
});

// ─── Wrapper helper ──────────────────────────────────────────────────────────

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-6 py-6">{children}</div>
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
    return (
      <Page>
        <ResourcesTab />
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
    return <div className="h-full overflow-hidden"><PlaygroundPage sessionId={sessionId} /></div>;
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
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
  quickstartRoute,
]);

// ─── Router ───────────────────────────────────────────────────────────────────

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
