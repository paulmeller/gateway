import { useState } from "react";
import { Copy, Key, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppStore } from "@/stores/app-store";
import { toast } from "sonner";

export function ApiKeysPage() {
  const apiKey = useAppStore((s) => s.apiKey) || window.__MA_API_KEY__ || "";
  const setApiKey = useAppStore((s) => s.setApiKey);
  const [draft, setDraft] = useState(apiKey);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!apiKey) return;
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    toast.success("API key copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSave() {
    if (!draft.trim()) return;
    setApiKey(draft.trim());
    toast.success("API key updated");
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6 flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">API Keys</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage your gateway API key.</p>
      </div>

      {/* Current key card */}
      <div className="rounded-lg border border-border bg-card p-5 flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Key className="size-4 text-muted-foreground" />
          Current API Key
        </div>

        {apiKey ? (
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs text-foreground break-all select-all">
              {apiKey}
            </code>
            <Button
              variant="outline"
              size="icon"
              className="shrink-0"
              onClick={handleCopy}
              title="Copy to clipboard"
            >
              {copied ? (
                <Check className="size-4 text-lime-400" />
              ) : (
                <Copy className="size-4" />
              )}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No API key configured.</p>
        )}

        <p className="text-xs text-muted-foreground">
          This key authenticates all API requests to this gateway instance.
        </p>
      </div>

      {/* Change key card */}
      <div className="rounded-lg border border-border bg-card p-5 flex flex-col gap-4">
        <div className="text-sm font-medium text-foreground">Update API Key</div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">New key</Label>
          <div className="flex gap-2">
            <Input
              className="flex-1 font-mono text-xs text-foreground"
              placeholder="sk-..."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
            <Button
              variant="secondary"
              onClick={handleSave}
              disabled={!draft.trim() || draft.trim() === apiKey}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
