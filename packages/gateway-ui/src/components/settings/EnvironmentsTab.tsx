import { useState } from "react";
import { Trash2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useEnvironments, useDeleteEnvironment } from "@/hooks/use-environments";
import { CreateEnvironmentDialog } from "./CreateEnvironmentDialog";
import { PageHeader } from "./PageHeader";
import { cn } from "@/lib/utils";

function timeAgo(ts: number | string): string {
  const ms = typeof ts === "string" ? new Date(ts).getTime() : ts;
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function EnvironmentsTab() {
  const { data: envs } = useEnvironments();
  const del = useDeleteEnvironment();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Environments"
        description="Configuration for containers and code execution."
        actionLabel="Add environment"
        onAction={() => setCreateOpen(true)}
      />

      {envs && envs.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {envs.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">{e.id.slice(0, 16)}...</TableCell>
                  <TableCell className="font-medium text-foreground">{e.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{e.config?.provider || "sprites"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("text-xs",
                      e.state === "ready" ? "border-lime-400/20 bg-lime-400/10 text-lime-400" : "text-muted-foreground"
                    )}>
                      {e.state}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{timeAgo(e.created_at)}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="size-7 text-muted-foreground" />}>
                          <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem className="text-destructive" onSelect={() => del.mutate(e.id)}>
                          <Trash2 className="mr-2 size-3.5" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">No environments yet.</p>
      )}

      <CreateEnvironmentDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
