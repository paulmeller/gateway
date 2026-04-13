import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/layout/AppShell";
import { SessionHeader } from "@/components/layout/SessionHeader";
import { ChatThread } from "@/components/chat/ChatThread";
import { ChatInput } from "@/components/chat/ChatInput";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { CommandPalette } from "@/components/shared/CommandPalette";
import { useAgents } from "@/hooks/use-agents";
import { useEnvironments } from "@/hooks/use-environments";
import { useAppStore } from "@/stores/app-store";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

function Main() {
  const { data: agents, isLoading: loadingAgents } = useAgents();
  const { data: envs, isLoading: loadingEnvs } = useEnvironments();
  const settingsOpen = useAppStore((s) => s.settingsOpen);

  if (loadingAgents || loadingEnvs) return null;

  if (settingsOpen) return <SettingsPage />;

  const needsOnboarding = !agents?.length || !envs?.length;
  if (needsOnboarding) return <OnboardingWizard />;

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
