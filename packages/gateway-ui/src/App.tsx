import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/layout/AppShell";
import { SessionHeader } from "@/components/layout/SessionHeader";
import { ChatThread } from "@/components/chat/ChatThread";
import { ChatInput } from "@/components/chat/ChatInput";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { DashboardPage } from "@/components/dashboard/DashboardPage";
import { CommandPalette } from "@/components/shared/CommandPalette";
import { useAppStore } from "@/stores/app-store";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

function Main() {
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const dashboardOpen = useAppStore((s) => s.dashboardOpen);

  if (dashboardOpen) return <DashboardPage />;
  if (settingsOpen) return <SettingsPage />;

  return (
    <>
      <SessionHeader />
      <ChatThread />
      <ChatInput />
    </>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppShell>
          <Main />
        </AppShell>
        <Toaster position="top-center" richColors />
        <CommandPalette />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
