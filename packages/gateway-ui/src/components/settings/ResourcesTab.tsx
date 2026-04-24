import { useRef, useState } from "react";
import { Trash2, Download, Upload, GitBranch, File as FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader } from "./PageHeader";
import { useFiles, useUploadFile, useDeleteFile, downloadFile, type FileRecord } from "@/hooks/use-files";
import { useSessions } from "@/hooks/use-sessions";
import { useRepositories, useSaveRepositories } from "@/hooks/use-repositories";
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

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// Legacy export for backward compat
export function ResourcesTab() {
  return (
    <div className="flex flex-col gap-12">
      <FilesPanel />
      <RepositoriesSection />
    </div>
  );
}

// ─── Files Panel (session-centric) ──────────────────────────────────────

export function FilesPanel() {
  const { data: files } = useFiles();
  const { data: sessions } = useSessions();
  const upload = useUploadFile();
  const deleteFileMut = useDeleteFile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; filename: string } | null>(null);

  // Group files by session scope
  const sessionMap = new Map<string, { title: string; agent: string }>();
  sessions?.forEach((s) => {
    sessionMap.set(s.id, { title: s.title ?? s.id.slice(0, 20), agent: s.agent?.id?.slice(0, 16) ?? "" });
  });

  const grouped = new Map<string, FileRecord[]>();
  const unscoped: FileRecord[] = [];
  files?.forEach((f) => {
    if (f.scope?.id) {
      const list = grouped.get(f.scope.id) ?? [];
      list.push(f);
      grouped.set(f.scope.id, list);
    } else {
      unscoped.push(f);
    }
  });

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await upload.mutateAsync(file);
      toast.success(`"${file.name}" uploaded`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDownload(id: string, filename: string) {
    try { await downloadFile(id, filename); } catch { toast.error("Download failed"); }
  }

  const totalFiles = files?.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Files"
        description={`${totalFiles} file${totalFiles !== 1 ? "s" : ""} across ${grouped.size} session${grouped.size !== 1 ? "s" : ""}`}
        actionLabel="Upload file"
        onAction={() => fileInputRef.current?.click()}
      />
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />

      {totalFiles === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-12 text-center">
          <Upload className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No files yet</p>
          <p className="text-xs text-muted-foreground/60">Files created by agents during sessions will appear here</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Session-grouped files */}
          {Array.from(grouped.entries()).map(([sessionId, sessionFiles]) => {
            const info = sessionMap.get(sessionId);
            return (
              <div key={sessionId} className="rounded-lg border border-border">
                <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2">
                  <FileIcon className="size-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground truncate">
                    {info?.title ?? sessionId.slice(0, 24)}
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono">{sessionId.slice(0, 20)}...</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{sessionFiles.length} file{sessionFiles.length !== 1 ? "s" : ""}</span>
                </div>
                <Table>
                  <TableBody>
                    {sessionFiles.map((f) => (
                      <TableRow key={f.id}>
                        <TableCell className="font-medium text-foreground">{f.filename}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">{formatSize(f.size_bytes)}</TableCell>
                        <TableCell className="font-mono text-[10px] text-muted-foreground">{f.mime_type}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{timeAgo(f.created_at)}</TableCell>
                        <TableCell className="w-[80px]">
                          <div className="flex items-center gap-1">
                            {f.downloadable && (
                              <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground"
                                onClick={() => handleDownload(f.id, f.filename)}>
                                <Download className="size-3.5" />
                              </Button>
                            )}
                            <Button variant="ghost" size="icon" className="size-7 text-red-400/40 hover:text-red-400"
                              onClick={() => setDeleteTarget({ id: f.id, filename: f.filename })}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            );
          })}

          {/* Unscoped files */}
          {unscoped.length > 0 && (
            <div className="rounded-lg border border-border">
              <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2">
                <Upload className="size-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">Uploaded (no session)</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{unscoped.length} file{unscoped.length !== 1 ? "s" : ""}</span>
              </div>
              <Table>
                <TableBody>
                  {unscoped.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell className="font-medium text-foreground">{f.filename}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{formatSize(f.size_bytes)}</TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground">{f.mime_type}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{timeAgo(f.created_at)}</TableCell>
                      <TableCell className="w-[80px]">
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-foreground"
                            onClick={() => handleDownload(f.id, f.filename)}>
                            <Download className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="size-7 text-red-400/40 hover:text-red-400"
                            onClick={() => setDeleteTarget({ id: f.id, filename: f.filename })}>
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.filename}"?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete the file.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              if (deleteTarget) {
                deleteFileMut.mutate(deleteTarget.id, {
                  onSuccess: () => toast.success("File deleted"),
                  onError: () => toast.error("Failed to delete"),
                });
              }
              setDeleteTarget(null);
            }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Repositories Section ───────────────────────────────────────────────

export function RepositoriesSection() {
  const { data: repos } = useRepositories();
  const saveRepos = useSaveRepositories();
  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");

  async function handleAdd() {
    if (!url.trim()) return;
    const current = repos ?? [];
    const newRepo = { url: url.trim(), branch: branch.trim() || "main", added_at: new Date().toISOString() };
    try {
      await saveRepos.mutateAsync([...current, newRepo]);
      toast.success("Repository saved");
      setUrl("");
      setBranch("main");
      setAddOpen(false);
    } catch { toast.error("Failed to save repository"); }
  }

  async function handleDelete(repoUrl: string) {
    const current = repos ?? [];
    try {
      await saveRepos.mutateAsync(current.filter((r) => r.url !== repoUrl));
      toast.success("Repository removed");
    } catch { toast.error("Failed to remove repository"); }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Repositories"
        description="Save repository URLs for agents to clone during sessions."
        actionLabel="Add repository"
        onAction={() => setAddOpen(true)}
      />

      {repos && repos.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>URL</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {repos.map((r) => (
                <TableRow key={r.url}>
                  <TableCell className="font-mono text-xs text-foreground">{r.url}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <GitBranch className="size-3" />
                      {r.branch}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{timeAgo(r.added_at)}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="size-7 text-red-400/40 hover:text-red-400"
                      onClick={() => handleDelete(r.url)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-12 text-center">
          <GitBranch className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No repositories saved yet</p>
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-foreground">Add repository</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 pt-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Repository URL</Label>
              <Input placeholder="https://github.com/org/repo" value={url} onChange={(e) => setUrl(e.target.value)}
                className="w-full text-foreground" onKeyDown={(e) => e.key === "Enter" && handleAdd()} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Branch</Label>
              <Input placeholder="main" value={branch} onChange={(e) => setBranch(e.target.value)}
                className="w-full text-foreground" onKeyDown={(e) => e.key === "Enter" && handleAdd()} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button className="bg-cta-gradient text-black hover:opacity-90" onClick={handleAdd}
                disabled={!url.trim() || saveRepos.isPending}>Add</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
