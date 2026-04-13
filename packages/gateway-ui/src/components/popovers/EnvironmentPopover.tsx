import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface Environment { id: string; name: string; state: string; config: { provider?: string; [key: string]: unknown }; }
interface Props { envId: string; children: React.ReactNode; }

export function EnvironmentPopover({ envId, children }: Props) {
  const { data: env } = useQuery({
    queryKey: ["environments", envId],
    queryFn: () => api<Environment>(`/environments/${envId}`),
    enabled: !!envId,
  });
  if (!env) return <>{children}</>;
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-64 border-border bg-card p-4" align="start">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground">{env.name}</h4>
            <Badge
              variant="outline"
              className={cn("text-xs", env.state === "ready"
                ? "border-lime-400/20 bg-lime-400/10 text-lime-400"
                : "border-border text-muted-foreground"
              )}
            >
              {env.state}
            </Badge>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Provider</p>
            <p className="font-mono text-xs text-muted-foreground">{env.config?.provider || "sprites"}</p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
