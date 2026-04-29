import { create } from "zustand";

/** Base path for the SPA, set by the host page via window.__BASE_PATH__. */
const BASE = ((window as unknown as { __BASE_PATH__?: string }).__BASE_PATH__ || "").replace(/\/$/, "");

/** Prepend the basepath to an app-relative path. */
export function withBase(path: string): string {
  return BASE ? `${BASE}${path}` : path;
}

/** Strip the basepath prefix from a pathname for route matching. */
function stripBase(pathname: string): string {
  return BASE && pathname.startsWith(BASE) ? pathname.slice(BASE.length) || "/" : pathname;
}

interface Route {
  sessionId: string | null;
  settingsOpen: boolean;
  selectedAgentId: string | null;
  dashboardOpen: boolean;
}

function getInitialRoute(): Route {
  const path = stripBase(window.location.pathname);
  if (path === "/analytics") {
    return {
      sessionId: null,
      settingsOpen: false,
      selectedAgentId: null,
      dashboardOpen: true,
    };
  }
  const agentMatch = path.match(/^\/agents\/(.+)$/);
  if (agentMatch) {
    return {
      sessionId: null,
      settingsOpen: true,
      selectedAgentId: agentMatch[1],
      dashboardOpen: false,
    };
  }
  if (path === "/settings") {
    return {
      sessionId: null,
      settingsOpen: true,
      selectedAgentId: null,
      dashboardOpen: false,
    };
  }
  const playgroundMatch = path.match(/^\/playground\/(.+)$/);
  if (playgroundMatch) {
    return {
      sessionId: playgroundMatch[1],
      settingsOpen: false,
      selectedAgentId: null,
      dashboardOpen: false,
    };
  }
  const match = path.match(/^\/sessions\/(.+)$/);
  if (match) {
    return {
      sessionId: match[1],
      settingsOpen: false,
      selectedAgentId: null,
      dashboardOpen: false,
    };
  }
  return {
    sessionId: null,
    settingsOpen: false,
    selectedAgentId: null,
    dashboardOpen: false,
  };
}

const initial = getInitialRoute();

interface AppState {
  apiKey: string;
  setApiKey: (key: string) => void;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  debugOpen: boolean;
  toggleDebug: () => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string | null) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  /** Observability dashboard state */
  dashboardOpen: boolean;
  setDashboardOpen: (open: boolean) => void;
  dashboardWindowMinutes: number;
  setDashboardWindowMinutes: (m: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
  apiKey: window.__MA_API_KEY__ || localStorage.getItem("ma-api-key") || "",
  setApiKey: (key) => {
    localStorage.setItem("ma-api-key", key);
    set({ apiKey: key });
  },
  activeSessionId: initial.sessionId,
  setActiveSessionId: (id) => {
    if (id) {
      window.history.pushState(null, "", withBase(`/sessions/${id}`));
    } else {
      window.history.pushState(null, "", withBase("/"));
    }
    set({ activeSessionId: id, settingsOpen: false });
  },
  debugOpen: false,
  toggleDebug: () => set((s) => ({ debugOpen: !s.debugOpen })),
  selectedAgentId: initial.selectedAgentId,
  // URL-agnostic: callers should use the router (`navigate({to: "/agents/$id"})`).
  // This store action only syncs the state — the agentDetailRoute's useEffect
  // calls it with the param on navigation.
  setSelectedAgentId: (id) => set({ selectedAgentId: id }),
  settingsOpen: initial.settingsOpen,
  setSettingsOpen: (open) => {
    if (open) {
      window.history.pushState(null, "", withBase("/settings"));
    } else {
      const sid = useAppStore.getState().activeSessionId;
      window.history.pushState(null, "", withBase(sid ? `/sessions/${sid}` : "/"));
    }
    set({ settingsOpen: open, dashboardOpen: open ? false : useAppStore.getState().dashboardOpen });
  },
  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  commandOpen: false,
  setCommandOpen: (open) => set({ commandOpen: open }),
  dashboardOpen: initial.dashboardOpen,
  setDashboardOpen: (open) => {
    if (open) {
      window.history.pushState(null, "", withBase("/analytics"));
    } else {
      const sid = useAppStore.getState().activeSessionId;
      window.history.pushState(null, "", withBase(sid ? `/sessions/${sid}` : "/"));
    }
    // Opening the dashboard closes settings (and vice-versa) so they
    // don't collide — SettingsPage and DashboardPage both render in
    // the main content slot.
    set({ dashboardOpen: open, settingsOpen: open ? false : useAppStore.getState().settingsOpen });
  },
  dashboardWindowMinutes: 60,
  setDashboardWindowMinutes: (m) => set({ dashboardWindowMinutes: m }),
}));

// Handle browser back/forward
window.addEventListener("popstate", () => {
  const { sessionId, settingsOpen, selectedAgentId, dashboardOpen } = getInitialRoute();
  useAppStore.setState({
    activeSessionId: sessionId,
    settingsOpen,
    selectedAgentId,
    dashboardOpen,
  });
});
