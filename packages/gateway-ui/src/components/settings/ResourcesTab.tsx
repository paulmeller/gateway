import { useRef, useState } from "react";
import { Trash2, Download, Upload, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PageHeader } from "./PageHeader";
import { useFiles, useUploadFile, useDeleteFile, downloadFile } from "@/hooks/use-files";
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
  return `${bytes} bytes`;
}

export function ResourcesTab() {
  return (
    <div className="flex flex-col gap-12">
      <FilesSection />
      <RepositoriesSection />
    </div>
  );
}

function FilesSection() {
  const { data: files } = useFiles();
  const upload = useUploadFile();
  const deleteFile = useDeleteFile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; filename: string } | null>(null);

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
    try {
      await downloadFile(id, filename);
    } catch {
      toast.error("Download failed");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Files"
        description="Upload files to share with agents during sessions."
        actionLabel="Upload file"
        onAction={() => fileInputRef.current?.click()}
      />
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleUpload}
      />

      {files && files.length > 0 ? (
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Filename</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="font-medium text-foreground">{f.filename}</TableCell>
                  <TableCell className="text-muted-foreground">{formatSize(f.size)}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{f.content_type}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{timeAgo(f.created_at)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-foreground"
                        onClick={() => handleDownload(f.id, f.filename)}
                      >
                        <Download className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-red-400/40 hover:text-red-400"
                        onClick={() => setDeleteTarget({ id: f.id, filename: f.filename })}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-12 text-center">
          <Upload className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No files uploaded yet</p>
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.filename}"?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete the file. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  deleteFile.mutate(deleteTarget.id, {
                    onSuccess: () => toast.success("File deleted"),
                    onError: () => toast.error("Failed to delete file"),
                  });
                }
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RepositoriesSection() {
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
    } catch {
      toast.error("Failed to save repository");
    }
  }

  async function handleDelete(repoUrl: string) {
    const current = repos ?? [];
    try {
      await saveRepos.mutateAsync(current.filter((r) => r.url !== repoUrl));
      toast.success("Repository removed");
    } catch {
      toast.error("Failed to remove repository");
    }
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
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-red-400/40 hover:text-red-400"
                      onClick={() => handleDelete(r.url)}
                    >
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
              <Input
                placeholder="https://github.com/org/repo"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full text-foreground"
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Branch</Label>
              <Input
                placeholder="main"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="w-full text-foreground"
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button
                className="bg-cta-gradient text-black hover:opacity-90"
                onClick={handleAdd}
                disabled={!url.trim() || saveRepos.isPending}
              >
                Add
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
