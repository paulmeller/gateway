import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppStore } from "@/stores/app-store";
import { AgentsTab } from "./AgentsTab";
import { EnvironmentsTab } from "./EnvironmentsTab";
import { VaultsTab } from "./VaultsTab";

export function SettingsDrawer() {
  const { settingsOpen, setSettingsOpen } = useAppStore();
  return (
    <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
      <SheetContent side="left" className="w-80 overflow-y-auto">
        <SheetHeader><SheetTitle>Settings</SheetTitle></SheetHeader>
        <Tabs defaultValue="agents" className="mt-4">
          <TabsList className="w-full">
            <TabsTrigger value="agents" className="flex-1 text-xs">Agents</TabsTrigger>
            <TabsTrigger value="environments" className="flex-1 text-xs">Envs</TabsTrigger>
            <TabsTrigger value="vaults" className="flex-1 text-xs">Vaults</TabsTrigger>
          </TabsList>
          <TabsContent value="agents"><AgentsTab /></TabsContent>
          <TabsContent value="environments"><EnvironmentsTab /></TabsContent>
          <TabsContent value="vaults"><VaultsTab /></TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
