import { useState } from "react";
import { Trash2, Plus, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMemoryStores, useCreateMemoryStore, useDeleteMemoryStore, useMemories, useCreateMemory, useDeleteMemory } from "@/hooks/use-memory-stores";
import { PageHeader } from "./PageHeader";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function MemoryStoresTab() {
  const { data: stores } = useMemoryStores();
  const del = useDeleteMemoryStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Memory stores"
        description="Persistent key-value stores for agent memory."
        actionLabel="New store"
        onAction={() => setCreateOpen(true)}
      />

      {stores && stores.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead className="w-[160px]">ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {stores.map((s) => (
                <>
                  <TableRow key={s.id} className="cursor-pointer" onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}>
                    <TableCell>
                      <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", expandedId === s.id && "rotate-90")} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{s.id.slice(0, 18)}...</TableCell>
                    <TableCell className="font-medium text-foreground">{s.name}</TableCell>
                    <TableCell className="text-muted-foreground">{s.description || "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{timeAgo(s.created_at)}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="size-7 text-red-400/40 hover:text-red-400"
                        onClick={(e) => { e.stopPropagation(); del.mutate(s.id); }}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                  {expandedId === s.id && (
                    <TableRow key={`${s.id}-memories`}>
                      <TableCell colSpan={6} className="bg-muted/50 p-4">
                        <MemoryEntries storeId={s.id} />
                      </TableCell>
                    </TableRow>
                  )}
                </>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">No memory stores yet.</p>
      )}

      <CreateMemoryStoreDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function CreateMemoryStoreDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const create = useCreateMemoryStore();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  async function handleCreate() {
    if (!name.trim()) return;
    await create.mutateAsync({ name: name.trim(), description: description.trim() || undefined });
    setName("");
    setDescription("");
    toast.success("Memory store created");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle className="text-foreground">New memory store</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4 pt-2">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input placeholder="my-store" value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Description</Label>
            <Input placeholder="Optional description" value={description} onChange={(e) => setDescription(e.target.value)} className="w-full" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button className="bg-cta-gradient text-black hover:opacity-90" onClick={handleCreate} disabled={!name.trim() || create.isPending}>Create</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MemoryEntries({ storeId }: { storeId: string }) {
  const { data: memories } = useMemories(storeId);
  const createMem = useCreateMemory();
  const deleteMem = useDeleteMemory();
  const [newPath, setNewPath] = useState("");
  const [newContent, setNewContent] = useState("");

  async function handleAdd() {
    if (!newPath.trim() || !newContent.trim()) return;
    await createMem.mutateAsync({ storeId, path: newPath.trim(), content: newContent.trim() });
    setNewPath("");
    setNewContent("");
    toast.success("Memory created");
  }

  return (
    <div className="flex flex-col gap-2">
      {memories?.map((m) => (
        <div key={m.id} className="flex items-start gap-3 rounded-md bg-background px-3 py-2">
          <div className="flex-1 min-w-0">
            <p className="font-mono text-xs text-lime-400/60">{m.path}</p>
            <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-all">{m.content.slice(0, 200)}{m.content.length > 200 ? "..." : ""}</p>
          </div>
          <Button variant="ghost" size="icon" className="size-6 shrink-0 text-red-400/30 hover:text-red-400"
            onClick={() => deleteMem.mutate({ storeId, memoryId: m.id })}>
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
      <div className="flex flex-col gap-2 pt-1">
        <Input placeholder="Path (e.g. notes/todo)" value={newPath} onChange={(e) => setNewPath(e.target.value)} className="h-8 w-full font-mono text-xs" />
        <div className="flex gap-2">
          <Textarea placeholder="Content" value={newContent} onChange={(e) => setNewContent(e.target.value)} className="min-h-[60px] w-full text-xs" rows={2} />
          <Button size="icon" className="size-8 shrink-0 self-end bg-cta-gradient text-black hover:opacity-90" onClick={handleAdd}>
            <Plus className="size-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
