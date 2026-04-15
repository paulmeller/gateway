import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppStore } from "@/stores/app-store";
import { AgentsTab } from "./AgentsTab";
import { EnvironmentsTab } from "./EnvironmentsTab";
import { VaultsTab } from "./VaultsTab";
import { MemoryStoresTab } from "./MemoryStoresTab";
import { ResourcesTab } from "./ResourcesTab";
import { AgentDetailPage } from "./AgentDetailPage";

export function SettingsPage() {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const selectedAgentId = useAppStore((s) => s.selectedAgentId);

  if (selectedAgentId) return <AgentDetailPage />;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b px-6 py-3">
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={() => setSettingsOpen(false)}>
          <ArrowLeft className="size-4" />
        </Button>
        <h2 className="text-sm font-semibold text-foreground">Settings</h2>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-6">
          <Tabs defaultValue="agents">
            <TabsList>
              <TabsTrigger value="agents">Agents</TabsTrigger>
              <TabsTrigger value="environments">Environments</TabsTrigger>
              <TabsTrigger value="vaults">Vaults</TabsTrigger>
              <TabsTrigger value="memory">Memory</TabsTrigger>
              <TabsTrigger value="resources">Resources</TabsTrigger>
            </TabsList>
            <TabsContent value="agents" className="mt-6"><AgentsTab /></TabsContent>
            <TabsContent value="environments" className="mt-6"><EnvironmentsTab /></TabsContent>
            <TabsContent value="vaults" className="mt-6"><VaultsTab /></TabsContent>
            <TabsContent value="memory" className="mt-6"><MemoryStoresTab /></TabsContent>
            <TabsContent value="resources" className="mt-6"><ResourcesTab /></TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
