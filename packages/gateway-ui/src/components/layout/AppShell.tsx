import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { DebugPanel } from "./DebugPanel";
import { useAppStore } from "@/stores/app-store";
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const debugOpen = useAppStore((s) => s.debugOpen);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "d") {
        e.preventDefault();
        useAppStore.getState().toggleDebug();
      }
      if (meta && e.key === "n") {
        e.preventDefault();
        useAppStore.getState().setActiveSessionId(null);
      }
      if (meta && e.key === ",") {
        e.preventDefault();
        useAppStore.getState().setSettingsOpen(true);
      }
      if (e.key === "Escape") {
        const state = useAppStore.getState();
        if (state.dashboardOpen) {
          state.setDashboardOpen(false);
        } else if (state.settingsOpen) {
          state.setSettingsOpen(false);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-screen max-h-screen overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden">
          {children}
          {debugOpen && <DebugPanel />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
