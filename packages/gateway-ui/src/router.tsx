import { createRouter, createRoute, createRootRoute, Outlet } from "@tanstack/react-router";
import { ConsoleNav } from "@/components/console-nav/ConsoleNav";
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
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <ConsoleNav />
      <main className="flex-1 overflow-y-auto bg-background">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
});

// ─── Wrapper helper ──────────────────────────────────────────────────────────

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-6">{children}</div>
  );
}

// ─── Placeholder factory ─────────────────────────────────────────────────────

function placeholder(title: string) {
  return function PlaceholderPage() {
    return (
      <Page>
        <h1 className="text-2xl font-semibold">{title}</h1>
      </Page>
    );
  };
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
  component: placeholder("Playground coming soon"),
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
