import { useState, useRef, useEffect } from "react";
import { ChevronDown, Upload, Trash2, File as FileIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

interface SessionFile {
  id: string;
  filename: string;
  size: number;
  resource_id?: string;
}

interface SessionResource {
  id: string;
  type: string;
  file_id?: string;
  mount_path?: string;
}

interface Props {
  sessionId: string | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PlaygroundFiles({ sessionId }: Props) {
  const [files, setFiles] = useState<SessionFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load existing session resources on mount / session change
  useEffect(() => {
    if (!sessionId) { setFiles([]); return; }
    api<{ data: SessionResource[] }>(`/sessions/${sessionId}/resources`)
      .then(res => {
        const fileResources = res.data.filter(r => r.type === "file" && r.file_id);
        const loaded: SessionFile[] = fileResources.map(r => ({
          id: r.file_id!,
          filename: r.mount_path ?? r.file_id!,
          size: 0,
          resource_id: r.id,
        }));
        setFiles(loaded);
      })
      .catch(() => {});
  }, [sessionId]);

  async function handleUpload(file: globalThis.File) {
    if (!sessionId) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const apiKey = useAppStore.getState().apiKey;
      const res = await fetch(`/v1/files?scope_id=${sessionId}&scope_type=session`, {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: "Upload failed" } }));
        throw new Error(err.error?.message || "Upload failed");
      }
      const uploaded = await res.json() as { id: string; filename: string; size: number };

      // Attach as session resource
      const resource = await api<SessionResource>(`/sessions/${sessionId}/resources`, {
        method: "POST",
        body: JSON.stringify({ type: "file", file_id: uploaded.id, mount_path: uploaded.filename }),
      });

      setFiles(prev => [...prev, { ...uploaded, resource_id: resource.id }]);
      toast.success(`Attached ${uploaded.filename}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove(file: SessionFile) {
    if (!sessionId) return;
    // Remove from UI immediately
    setFiles(prev => prev.filter(f => f.id !== file.id));
    try {
      if (file.resource_id) {
        await api(`/sessions/${sessionId}/resources/${file.resource_id}`, { method: "DELETE" });
      }
      toast.success(`Removed ${file.filename}`);
    } catch {
      toast.error(`Failed to remove ${file.filename}`);
      // Re-add on failure
      setFiles(prev => [...prev, file]);
    }
  }

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
        Files {files.length > 0 && <span className="font-mono text-[10px] font-normal">{files.length}</span>}
        <ChevronDown className="size-3.5 transition-transform data-[panel-open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 px-4 pb-4">
          {/* Upload button */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleUpload(file);
              e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-xs"
            disabled={!sessionId || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <><Loader2 className="size-3 mr-1.5 animate-spin" /> Uploading…</>
            ) : (
              <><Upload className="size-3 mr-1.5" /> Upload File</>
            )}
          </Button>

          {/* File list */}
          {files.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {files.map(f => (
                <div key={f.id} className="flex items-center justify-between py-1 group">
                  <div className="flex items-center gap-1.5 min-w-0 mr-2">
                    <FileIcon className="size-3 text-muted-foreground shrink-0" />
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs text-foreground truncate">{f.filename}</span>
                      {f.size > 0 && <span className="text-[10px] text-muted-foreground">{formatSize(f.size)}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemove(f)}
                    className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground">No files attached</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
