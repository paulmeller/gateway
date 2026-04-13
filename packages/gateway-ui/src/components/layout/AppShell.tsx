import { AppSidebar } from "@/components/app-sidebar";
import { DebugPanel } from "./DebugPanel";
import { useAppStore } from "@/stores/app-store";
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const debugOpen = useAppStore((s) => s.debugOpen);

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
