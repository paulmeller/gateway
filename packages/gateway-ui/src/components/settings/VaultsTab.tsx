import { useState } from "react";
import { Trash2, Plus, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useVaults, useVaultEntries, useCreateVault, useDeleteVault, usePutVaultEntry, useDeleteVaultEntry } from "@/hooks/use-vaults";
import { useAgents } from "@/hooks/use-agents";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader } from "./PageHeader";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

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

export function VaultsTab() {
  const { data: vaults } = useVaults();
  const deleteVault = useDeleteVault();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteVaultTarget, setDeleteVaultTarget] = useState<{ id: string; name: string } | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Credential vaults"
        description="Manage credential vaults that provide agents with access to APIs and services."
        actionLabel="New vault"
        onAction={() => setCreateOpen(true)}
      />

      {vaults && vaults.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead className="w-[140px]">ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Entries</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {vaults.map((v) => (
                <VaultRow
                  key={v.id}
                  vault={v}
                  expanded={expandedId === v.id}
                  onToggle={() => setExpandedId(expandedId === v.id ? null : v.id)}
                  onDelete={() => setDeleteVaultTarget({ id: v.id, name: v.name })}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No vaults yet. Create one to store API keys and credentials.
        </p>
      )}

      <CreateVaultDialog open={createOpen} onOpenChange={setCreateOpen} />

      <AlertDialog open={!!deleteVaultTarget} onOpenChange={(open) => !open && setDeleteVaultTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete vault "{deleteVaultTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete the vault and all its entries. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => { if (deleteVaultTarget) deleteVault.mutate(deleteVaultTarget.id); setDeleteVaultTarget(null); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CreateVaultDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const create = useCreateVault();
  const { data: agents } = useAgents();
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");

  async function handleCreate() {
    if (!name.trim() || !agentId) return;
    try {
      await create.mutateAsync({ name: name.trim(), agent_id: agentId });
      setName("");
      setAgentId("");
      toast.success("Vault created");
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = (err as { body?: { error?: { message?: string } } })?.body?.error?.message
        || (err instanceof Error ? err.message : "Failed to create vault");
      toast.error(msg);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New vault</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 pt-2">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input placeholder="default" value={name} onChange={(e) => setName(e.target.value)} className="w-full text-foreground" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Agent</Label>
            <Select value={agentId} onValueChange={(v: string | null) => { if (v) setAgentId(v); }}>
              <SelectTrigger className="w-full text-foreground"><SelectValue placeholder="Select an agent" /></SelectTrigger>
              <SelectContent>
                {agents?.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button className="bg-cta-gradient text-black hover:opacity-90" onClick={handleCreate} disabled={!name.trim() || !agentId || create.isPending}>Create</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VaultRow({ vault, expanded, onToggle, onDelete }: {
  vault: { id: string; name: string; entry_count: number; created_at: number };
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        <TableCell>
          <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">{vault.id.slice(0, 16)}...</TableCell>
        <TableCell className="font-medium text-foreground">{vault.name}</TableCell>
        <TableCell>
          <Badge variant="outline" className="border-lime-400/20 bg-lime-400/10 text-lime-400 text-xs">Active</Badge>
        </TableCell>
        <TableCell className="text-muted-foreground">{vault.entry_count}</TableCell>
        <TableCell className="text-muted-foreground">{timeAgo(vault.created_at)}</TableCell>
        <TableCell>
          <Button variant="ghost" size="icon" className="size-7 text-red-400/40 hover:text-red-400"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}>
            <Trash2 className="size-3.5" />
          </Button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={7} className="bg-muted/50 p-4">
            <VaultEntries vaultId={vault.id} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function VaultEntries({ vaultId }: { vaultId: string }) {
  const { data: entries } = useVaultEntries(vaultId);
  const putEntry = usePutVaultEntry();
  const deleteEntry = useDeleteVaultEntry();
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  async function handleAdd() {
    if (!newKey.trim() || !newValue.trim()) return;
    await putEntry.mutateAsync({ vaultId, key: newKey.trim(), value: newValue.trim() });
    setNewKey(""); setNewValue("");
    toast.success("Entry added");
  }

  return (
    <div className="flex flex-col gap-2">
      {entries?.map((e) => (
        <div key={e.key} className="flex items-center gap-3 rounded-md bg-background px-3 py-2">
          <span className="font-mono text-xs text-lime-400/60">{e.key}</span>
          <span className="flex-1 truncate font-mono text-xs text-muted-foreground">{e.value.slice(0, 8)}...{e.value.slice(-4)}</span>
          <Button variant="ghost" size="icon" className="size-6 text-red-400/30 hover:text-red-400"
            onClick={() => deleteEntry.mutate({ vaultId, key: e.key })}>
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Input placeholder="Key" value={newKey} onChange={(e) => setNewKey(e.target.value)} className="h-8 w-full font-mono text-xs text-foreground" />
        <Input placeholder="Value" type="password" value={newValue} onChange={(e) => setNewValue(e.target.value)} className="h-8 w-full font-mono text-xs text-foreground" />
        <Button size="icon" className="size-8 shrink-0 bg-cta-gradient text-black hover:opacity-90" onClick={handleAdd}>
          <Plus className="size-3" />
        </Button>
      </div>
    </div>
  );
}
