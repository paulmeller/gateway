import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateEnvironment } from "@/hooks/use-environments";
import { LOCAL_PROVIDERS, CLOUD_PROVIDERS, PROVIDER_TOKENS } from "@/lib/constants";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

const TOKEN_TO_SETTING: Record<string, string> = {
  SPRITE_TOKEN: "sprite_token",
  E2B_API_KEY: "e2b_api_key",
  VERCEL_TOKEN: "vercel_token",
  DAYTONA_API_KEY: "daytona_api_key",
  FLY_API_TOKEN: "fly_api_token",
  MODAL_TOKEN_ID: "modal_token_id",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateEnvironmentDialog({ open, onOpenChange }: Props) {
  const create = useCreateEnvironment();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("docker");
  const [token, setToken] = useState("");

  const tokenInfo = PROVIDER_TOKENS[provider];
  const needsToken = !!tokenInfo;

  async function handleCreate() {
    if (!name.trim()) return;
    try {
      if (needsToken && token.trim()) {
        const settingKey = TOKEN_TO_SETTING[tokenInfo.key];
        if (settingKey) {
          await api("/settings", { method: "PUT", body: JSON.stringify({ key: settingKey, value: token.trim() }) });
        }
      }
      await create.mutateAsync({ name: name.trim(), config: { provider } });
      setName("");
      setToken("");
      toast.success("Environment created");
      onOpenChange(false);
    } catch (err: unknown) {
      const apiErr = err as { body?: { error?: { message?: string } } };
      const msg = apiErr?.body?.error?.message || (err instanceof Error ? err.message : "Failed to create");
      toast.error(msg);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add environment</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 pt-2">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input placeholder="my-env" value={name} onChange={(e) => setName(e.target.value)} className="w-full text-foreground" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Provider</Label>
            <Select value={provider} onValueChange={(v) => { setProvider(v); setToken(""); }}>
              <SelectTrigger className="w-full text-foreground"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Local</SelectLabel>
                  {LOCAL_PROVIDERS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Cloud</SelectLabel>
                  {CLOUD_PROVIDERS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {needsToken && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">{tokenInfo.label}</Label>
              <Input type="password" placeholder={tokenInfo.placeholder} value={token} onChange={(e) => setToken(e.target.value)} className="w-full font-mono text-foreground" />
              <p className="text-xs text-muted-foreground/60">Saved to server settings for provider access.</p>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button className="bg-cta-gradient text-black hover:opacity-90" onClick={handleCreate} disabled={!name.trim() || create.isPending}>Create</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
