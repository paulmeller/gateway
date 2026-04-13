import { create } from "zustand";

function getInitialRoute(): { sessionId: string | null; settingsOpen: boolean } {
  const path = window.location.pathname;
  if (path === "/settings") return { sessionId: null, settingsOpen: true };
  const match = path.match(/^\/sessions\/(.+)$/);
  if (match) return { sessionId: match[1], settingsOpen: false };
  return { sessionId: null, settingsOpen: false };
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
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
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
  settingsOpen: initial.settingsOpen,
  setSettingsOpen: (open) => {
    if (open) {
      window.history.pushState(null, "", "/settings");
    } else {
      const sid = useAppStore.getState().activeSessionId;
      window.history.pushState(null, "", sid ? `/sessions/${sid}` : "/");
    }
    set({ settingsOpen: open });
  },
  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  commandOpen: false,
  setCommandOpen: (open) => set({ commandOpen: open }),
}));

// Handle browser back/forward
window.addEventListener("popstate", () => {
  const { sessionId, settingsOpen } = getInitialRoute();
  useAppStore.setState({ activeSessionId: sessionId, settingsOpen });
});
