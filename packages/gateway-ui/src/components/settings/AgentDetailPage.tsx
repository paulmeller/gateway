import { ArrowLeft } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppStore } from "@/stores/app-store";
import { useAgent } from "@/hooks/use-agents";
import { AgentConfigTab } from "./AgentConfigTab";
import { AgentSkillsTab } from "./AgentSkillsTab";
import { AgentAdvancedTab } from "./AgentAdvancedTab";
import { AgentEditTab } from "./AgentEditTab";

export function AgentDetailPage() {
  const agentId = useAppStore((s) => s.selectedAgentId);
  const navigate = useNavigate();
  const { data: agent, isLoading } = useAgent(agentId);

  if (isLoading || !agent) return null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b px-6 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          onClick={() => navigate({ to: "/agents" })}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-foreground">{agent.name}</h2>
          <p className="text-xs text-muted-foreground">
            {agent.engine} / {agent.model}
          </p>
        </div>
        <Badge
          variant="outline"
          className="border-lime-400/20 bg-lime-400/10 text-lime-400 text-xs"
        >
          Active
        </Badge>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div>
          <Tabs defaultValue="config">
            <TabsList>
              <TabsTrigger value="config">Config</TabsTrigger>
              <TabsTrigger value="skills">Skills</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
              <TabsTrigger value="edit">Edit</TabsTrigger>
            </TabsList>
            <TabsContent value="config" className="mt-6">
              <AgentConfigTab agent={agent} />
            </TabsContent>
            <TabsContent value="skills" className="mt-6">
              <AgentSkillsTab agent={agent} />
            </TabsContent>
            <TabsContent value="advanced" className="mt-6">
              <AgentAdvancedTab agent={agent} />
            </TabsContent>
            <TabsContent value="edit" className="mt-6">
              <AgentEditTab agent={agent} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
