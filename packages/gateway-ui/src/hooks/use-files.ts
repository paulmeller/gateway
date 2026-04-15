import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { useAppStore } from "@/stores/app-store";

interface FileRecord {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  created_at: string;
}

export function useFiles() {
  return useQuery({
    queryKey: ["files"],
    queryFn: () => api<{ data: FileRecord[] }>("/files"),
    select: (d) => d.data,
  });
}

export function useUploadFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const apiKey = useAppStore.getState().apiKey;
      const res = await fetch("/v1/files", {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: "Upload failed" } }));
        throw new Error(err.error?.message || `Upload failed (${res.status})`);
      }
      return res.json() as Promise<FileRecord>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files"] }),
  });
}

export function useDeleteFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/files/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["files"] }),
  });
}

export async function downloadFile(id: string, filename: string) {
  const apiKey = useAppStore.getState().apiKey;
  const res = await fetch(`/v1/files/${id}/content`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) throw new Error("Download failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
