import { useState, useRef } from "react";
import { Paperclip, Upload, X, File as FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

interface UploadedFile {
  id: string;
  filename: string;
  size: number;
}

interface Props {
  onFileAttached?: (fileId: string, filename: string) => void;
}

export function FileUpload({ onFileAttached }: Props) {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const [uploading, setUploading] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(file: globalThis.File) {
    if (!sessionId) return;
    setUploading(true);
    try {
      // Upload file
      const formData = new FormData();
      formData.append("file", file);
      const baseUrl = "/v1/files";
      const apiKey = localStorage.getItem("ma-api-key") || window.__MA_API_KEY__ || "";
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: "Upload failed" } }));
        throw new Error(err.error?.message || "Upload failed");
      }
      const uploaded = await res.json() as UploadedFile;

      // Attach to session as resource
      await api(`/sessions/${sessionId}/resources`, {
        method: "POST",
        body: JSON.stringify({
          type: "file",
          file_id: uploaded.id,
          mount_path: uploaded.filename,
        }),
      });

      setAttachedFiles((prev) => [...prev, uploaded]);
      onFileAttached?.(uploaded.id, uploaded.filename);
      toast.success(`Attached ${uploaded.filename}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    e.target.value = "";
  }

  function removeFile(id: string) {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  }

  if (!sessionId) return null;

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {attachedFiles.length > 0 && (
        <div className="mx-auto max-w-3xl mb-2 flex flex-wrap gap-1.5">
          {attachedFiles.map((f) => (
            <div
              key={f.id}
              className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
            >
              <FileIcon className="size-3" />
              <span className="truncate max-w-[120px]">{f.filename}</span>
              <button onClick={() => removeFile(f.id)} className="hover:text-foreground">
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileSelect}
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-[44px] shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
      >
        {uploading ? (
          <Upload className="size-4 animate-pulse" />
        ) : (
          <Paperclip className="size-4" />
        )}
      </Button>
    </div>
  );
}
