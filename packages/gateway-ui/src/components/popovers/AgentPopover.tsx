import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { useAgent } from "@/hooks/use-agents";

interface Props { agentId: string; children: React.ReactNode; }

export function AgentPopover({ agentId, children }: Props) {
  const { data: agent } = useAgent(agentId);
  if (!agent) return <>{children}</>;
  return (
    <Popover>
      <PopoverTrigger render={children as React.ReactElement} />
      <PopoverContent className="w-80 border-border bg-card p-4" align="start">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground">{agent.name}</h4>
            <Badge variant="outline" className="border-border text-xs font-mono text-muted-foreground">
              {agent.engine}
            </Badge>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Model</p>
            <p className="font-mono text-xs text-muted-foreground">{agent.model}</p>
          </div>
          {agent.system && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">System Prompt</p>
              <p className="max-h-24 overflow-y-auto text-xs leading-relaxed text-muted-foreground">
                {agent.system}
              </p>
            </div>
          )}
          {agent.tools && agent.tools.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                Tools ({agent.tools.length})
              </p>
              <div className="flex flex-wrap gap-1">
                {(agent.tools as Array<{name?: string; type?: string}>).map((t, i) => (
                  <Badge key={i} variant="outline" className="border-border text-xs font-mono text-muted-foreground">
                    {t.name || t.type || "tool"}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
