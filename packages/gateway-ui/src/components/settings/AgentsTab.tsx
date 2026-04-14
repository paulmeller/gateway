import { useState } from "react";
import { Pencil, Trash2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAgents, useDeleteAgent } from "@/hooks/use-agents";
import { AgentEditorDialog } from "./AgentEditorDialog";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { PageHeader } from "./PageHeader";

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

export function AgentsTab() {
  const { data: agents } = useAgents();
  const del = useDeleteAgent();
  const [createOpen, setCreateOpen] = useState(false);
  const [editAgent, setEditAgent] = useState<Record<string, unknown> | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agents"
        description="Create and manage autonomous agents."
        actionLabel="New agent"
        onAction={() => setCreateOpen(true)}
      />

      {agents && agents.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((a) => (
                <TableRow key={a.id} className="cursor-pointer" onClick={() => setEditAgent(a as Record<string, unknown>)}>
                  <TableCell className="font-mono text-xs text-muted-foreground">{a.id.slice(0, 16)}...</TableCell>
                  <TableCell className="font-medium text-foreground">{a.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{a.model}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="border-lime-400/20 bg-lime-400/10 text-lime-400 text-xs">Active</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{timeAgo(a.created_at)}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setTimeout(() => setEditAgent(a as Record<string, unknown>), 0)}>
                          <Pencil className="mr-2 size-3.5" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive" onSelect={() => del.mutate(a.id)}>
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
        <p className="py-8 text-center text-sm text-muted-foreground">No agents yet. Create one to get started.</p>
      )}

      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
      <AgentEditorDialog
        agent={editAgent as { id: string; name: string; [key: string]: unknown } | null}
        open={!!editAgent}
        onOpenChange={(open) => !open && setEditAgent(null)}
      />
    </div>
  );
}
