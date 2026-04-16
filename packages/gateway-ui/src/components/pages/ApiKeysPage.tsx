/**
 * API Keys management page — v0.4 rewrite.
 *
 * Shows:
 *   1. Current session key (the one the UI itself uses, from
 *      window.__MA_API_KEY__). Kept for operator convenience.
 *   2. Full table of virtual keys with scope summary, spend, created-at,
 *      and revoke action.
 *   3. "Create key" dialog with name + scope editor.
 *   4. Expandable detail rows showing recent activity for the key.
 *
 * Access: listing/creating/revoking requires admin permission. A
 * non-admin SEED_API_KEY sees only the session-key card and a 403 on
 * the list (handled by `useApiKeys` via query error).
 */
import { useState } from "react";
import { Copy, Key, Check, Plus, Trash2, Eye, EyeOff, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppStore } from "@/stores/app-store";
import { toast } from "sonner";
import {
  useApiKeys,
  useApiKeyActivity,
  useCreateApiKey,
  useRevokeApiKey,
  scopeSummary,
  type ApiKeyView,
  type KeyPermissions,
} from "@/hooks/use-api-keys";
import { KeyCostOverTime } from "@/components/dashboard/KeyCostOverTime";

function maskKey(key: string): string {
  if (key.length <= 10) return "••••••••";
  return `${key.slice(0, 6)}••••${key.slice(-4)}`;
}

function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Session key card (top) ──────────────────────────────────────────────

function SessionKeyCard() {
  const sessionKey = useAppStore((s) => s.apiKey) || window.__MA_API_KEY__ || "";
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!sessionKey) return;
    await navigator.clipboard.writeText(sessionKey);
    setCopied(true);
    toast.success("Copied");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Key className="size-4 text-muted-foreground" />
        Session API Key
      </div>
      {sessionKey ? (
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs text-foreground break-all select-all">
            {revealed ? sessionKey : maskKey(sessionKey)}
          </code>
          <Button variant="outline" size="icon" className="shrink-0" onClick={() => setRevealed(r => !r)} title={revealed ? "Hide" : "Reveal"}>
            {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
          <Button variant="outline" size="icon" className="shrink-0" onClick={copy} title="Copy">
            {copied ? <Check className="size-4 text-lime-400" /> : <Copy className="size-4" />}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No API key configured.</p>
      )}
      <p className="text-xs text-muted-foreground">
        The key this UI uses. To rotate the seeded server key, set <code className="font-mono text-[11px]">SEED_API_KEY</code> in <code className="font-mono text-[11px]">.env</code> and restart. For scoped keys, use the table below.
      </p>
    </div>
  );
}

// ─── Create key dialog ───────────────────────────────────────────────────

function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [name, setName] = useState("");
  const [admin, setAdmin] = useState(false);
  const [unrestricted, setUnrestricted] = useState(true);
  const [agentsCsv, setAgentsCsv] = useState("*");
  const [envsCsv, setEnvsCsv] = useState("*");
  const [vaultsCsv, setVaultsCsv] = useState("*");
  const [rawKey, setRawKey] = useState<string | null>(null);
  const create = useCreateApiKey();

  function reset() {
    setName("");
    setAdmin(false);
    setUnrestricted(true);
    setAgentsCsv("*");
    setEnvsCsv("*");
    setVaultsCsv("*");
    setRawKey(null);
  }

  async function handleCreate() {
    if (!name.trim()) { toast.error("Name is required"); return; }
    const permissions: KeyPermissions = admin
      ? { admin: true, scope: null }
      : {
          admin: false,
          scope: unrestricted ? null : {
            agents: agentsCsv.split(",").map(s => s.trim()).filter(Boolean),
            environments: envsCsv.split(",").map(s => s.trim()).filter(Boolean),
            vaults: vaultsCsv.split(",").map(s => s.trim()).filter(Boolean),
          },
        };
    try {
      const result = await create.mutateAsync({ name: name.trim(), permissions });
      setRawKey(result.key);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function copyRawKey() {
    if (rawKey) {
      await navigator.clipboard.writeText(rawKey);
      toast.success("Key copied — store it somewhere safe");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{rawKey ? "Key created" : "Create API key"}</DialogTitle>
        </DialogHeader>
        {rawKey ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-2 rounded border border-amber-400/30 bg-amber-400/5 p-3">
              <AlertCircle className="size-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-200">
                Copy this key now. It's only shown once and cannot be retrieved.
              </p>
            </div>
            <code className="block rounded bg-muted px-3 py-2 font-mono text-xs text-foreground break-all select-all">
              {rawKey}
            </code>
            <DialogFooter>
              <Button variant="outline" onClick={copyRawKey}>
                <Copy className="size-4 mr-1.5" /> Copy
              </Button>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Name</Label>
              <Input placeholder="e.g. ci-bot, frontend-dev, staging" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <input id="admin" type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} className="size-4" />
              <Label htmlFor="admin" className="cursor-pointer">Admin (can CRUD keys; overrides scope)</Label>
            </div>
            {!admin && (
              <>
                <div className="flex items-center gap-2">
                  <input id="unrestricted" type="checkbox" checked={unrestricted} onChange={(e) => setUnrestricted(e.target.checked)} className="size-4" />
                  <Label htmlFor="unrestricted" className="cursor-pointer">Unrestricted (can use any agent/env/vault)</Label>
                </div>
                {!unrestricted && (
                  <div className="flex flex-col gap-3 border-l-2 border-border pl-3">
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Agents (comma-separated IDs, or <code>*</code>)</Label>
                      <Input value={agentsCsv} onChange={(e) => setAgentsCsv(e.target.value)} placeholder="agent_abc, agent_def" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Environments</Label>
                      <Input value={envsCsv} onChange={(e) => setEnvsCsv(e.target.value)} placeholder="env_prod" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Vaults</Label>
                      <Input value={vaultsCsv} onChange={(e) => setVaultsCsv(e.target.value)} placeholder="*" />
                    </div>
                  </div>
                )}
              </>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={create.isPending}>
                {create.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Per-key activity detail ─────────────────────────────────────────────

function KeyActivity({ keyId }: { keyId: string }) {
  const { data, isLoading } = useApiKeyActivity(keyId);
  if (isLoading) return <p className="text-xs text-muted-foreground p-3">Loading…</p>;
  if (!data) return null;
  return (
    <div className="flex flex-col gap-2 p-4 bg-muted/30">
      <div className="grid grid-cols-4 gap-2 text-xs">
        <div><span className="text-muted-foreground">Sessions: </span><span className="font-mono">{data.totals.session_count}</span></div>
        <div><span className="text-muted-foreground">Turns: </span><span className="font-mono">{data.totals.turn_count}</span></div>
        <div><span className="text-muted-foreground">Errors: </span><span className="font-mono">{data.totals.error_count}</span></div>
        <div><span className="text-muted-foreground">Total cost: </span><span className="font-mono">{formatUsd(data.totals.cost_usd)}</span></div>
      </div>
      {data.sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground mt-2">No sessions yet.</p>
      ) : (
        <div className="mt-2 rounded border border-border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 text-[10px]">Session</TableHead>
                <TableHead className="h-8 text-[10px]">Agent</TableHead>
                <TableHead className="h-8 text-[10px]">Status</TableHead>
                <TableHead className="h-8 text-[10px]">Turns</TableHead>
                <TableHead className="h-8 text-[10px]">Cost</TableHead>
                <TableHead className="h-8 text-[10px]">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.sessions.slice(0, 10).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-[10px] text-muted-foreground py-1.5">{s.id.slice(0, 16)}…</TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground py-1.5">{s.agent.id.slice(0, 16)}…</TableCell>
                  <TableCell className="text-[10px] py-1.5">{s.status}</TableCell>
                  <TableCell className="text-[10px] py-1.5">{s.turn_count}</TableCell>
                  <TableCell className="text-[10px] py-1.5 font-mono">{formatUsd(s.usage_cost_usd)}</TableCell>
                  <TableCell className="text-[10px] py-1.5 text-muted-foreground">{timeAgo(new Date(s.created_at).getTime())}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────

export function ApiKeysPage() {
  const { data: keys, isError, error } = useApiKeys();
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeKey, setRevokeKey] = useState<ApiKeyView | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const revoke = useRevokeApiKey();

  const adminForbidden = isError && /403|forbidden|admin permission/i.test(String(error));

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">API Keys</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage virtual keys: scope access to specific agents/environments/vaults, track per-key usage.
        </p>
      </div>

      <SessionKeyCard />

      {adminForbidden ? (
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground">
            Key management requires an admin key. The current session is using a non-admin key.
          </p>
        </div>
      ) : (
        <>
          <KeyCostOverTime />

          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground">Virtual keys</h2>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger render={<Button size="sm"><Plus className="size-3.5 mr-1" />Create key</Button>} />
              <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
            </Dialog>
          </div>

          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys?.map((k) => (
                  <>
                    <TableRow
                      key={k.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => setExpandedId(expandedId === k.id ? null : k.id)}
                    >
                      <TableCell className="font-medium">{k.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{k.prefix}</TableCell>
                      <TableCell>
                        {k.permissions.admin ? (
                          <Badge variant="outline" className="border-lime-400/20 bg-lime-400/10 text-lime-400 text-xs">admin</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">{scopeSummary(k.permissions)}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{timeAgo(k.created_at)}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => setRevokeKey(k)}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                    {expandedId === k.id && (
                      <TableRow key={`${k.id}-detail`}>
                        <TableCell colSpan={5} className="p-0">
                          <KeyActivity keyId={k.id} />
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                ))}
                {keys?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                      No virtual keys yet. Click "Create key" to add one.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <AlertDialog open={!!revokeKey} onOpenChange={(v) => !v && setRevokeKey(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke "{revokeKey?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Any client using this key will get 401 on their next request. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (revokeKey) {
                  revoke.mutate(revokeKey.id, {
                    onSuccess: () => toast.success(`Revoked "${revokeKey.name}"`),
                    onError: (err) => toast.error(String(err)),
                  });
                  setRevokeKey(null);
                }
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
