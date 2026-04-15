import { create } from "zustand";

interface Route {
  sessionId: string | null;
  settingsOpen: boolean;
  selectedAgentId: string | null;
  dashboardOpen: boolean;
}

function getInitialRoute(): Route {
  const path = window.location.pathname;
  if (path === "/dashboard") {
    return {
      sessionId: null,
      settingsOpen: false,
      selectedAgentId: null,
      dashboardOpen: true,
    };
  }
  const agentMatch = path.match(/^\/settings\/agents\/(.+)$/);
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
      window.history.pushState(null, "", `/sessions/${id}`);
    } else {
      window.history.pushState(null, "", "/");
    }
    set({ activeSessionId: id, settingsOpen: false });
  },
  debugOpen: false,
  toggleDebug: () => set((s) => ({ debugOpen: !s.debugOpen })),
  selectedAgentId: initial.selectedAgentId,
  setSelectedAgentId: (id) => {
    if (id) {
      window.history.pushState(null, "", `/settings/agents/${id}`);
    } else {
      window.history.pushState(null, "", "/settings");
    }
    set({ selectedAgentId: id, settingsOpen: true });
  },
  settingsOpen: initial.settingsOpen,
  setSettingsOpen: (open) => {
    if (open) {
      window.history.pushState(null, "", "/settings");
    } else {
      const sid = useAppStore.getState().activeSessionId;
      window.history.pushState(null, "", sid ? `/sessions/${sid}` : "/");
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
      window.history.pushState(null, "", "/dashboard");
    } else {
      const sid = useAppStore.getState().activeSessionId;
      window.history.pushState(null, "", sid ? `/sessions/${sid}` : "/");
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
