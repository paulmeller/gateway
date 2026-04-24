import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUpdateAgent, type Agent } from "@/hooks/use-agents";
import { FALLBACK_MODELS, ENGINES } from "@/lib/constants";
import { ModelCombobox } from "@/components/ModelCombobox";
import { toast } from "sonner";

interface Props {
  agent: Agent;
}

export function AgentConfigTab({ agent }: Props) {
  const update = useUpdateAgent();
  const [name, setName] = useState(agent.name);
  const [engine, setEngine] = useState(agent.engine);
  const [model, setModel] = useState(agent.model);
  const [system, setSystem] = useState(agent.system || "");
  const [threadsEnabled, setThreadsEnabled] = useState(
    agent.threads_enabled ?? false
  );
  const [confirmationMode, setConfirmationMode] = useState(
    agent.confirmation_mode ?? false
  );

  const dirty =
    name !== agent.name ||
    engine !== agent.engine ||
    model !== agent.model ||
    system !== (agent.system || "") ||
    threadsEnabled !== (agent.threads_enabled ?? false) ||
    confirmationMode !== (agent.confirmation_mode ?? false);

  async function handleSave() {
    try {
      await update.mutateAsync({
        id: agent.id,
        name,
        engine,
        model,
        system: system || undefined,
        threads_enabled: threadsEnabled,
        confirmation_mode: confirmationMode,
      });
      toast.success("Agent updated");
    } catch {
      toast.error("Failed to update agent");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="agent-name" className="text-sm text-foreground">
          Name
        </Label>
        <Input
          id="agent-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="text-foreground"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-sm text-foreground">Engine</Label>
          <Select
            value={engine}
            onValueChange={(v) => {
              if (v) { setEngine(v); setModel(FALLBACK_MODELS[v]?.[0] ?? ""); }
            }}
          >
            <SelectTrigger className="text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENGINES.map((e) => (
                <SelectItem key={e} value={e}>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-sm text-foreground">Model</Label>
          <ModelCombobox engine={engine} value={model} onChange={setModel} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="agent-system" className="text-sm text-foreground">
          System Prompt
        </Label>
        <Textarea
          id="agent-system"
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          placeholder="Optional system prompt for the agent..."
          className="min-h-[120px] text-foreground"
        />
      </div>

      <div className="flex flex-col gap-4 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              Threads Enabled
            </p>
            <p className="text-xs text-muted-foreground">
              Allow agent to spawn child sessions
            </p>
          </div>
          <Switch
            checked={threadsEnabled}
            onCheckedChange={setThreadsEnabled}
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              Confirmation Mode
            </p>
            <p className="text-xs text-muted-foreground">
              Require confirmation before executing tools
            </p>
          </div>
          <Switch
            checked={confirmationMode}
            onCheckedChange={setConfirmationMode}
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          className="bg-cta-gradient text-black font-medium hover:opacity-90"
          onClick={handleSave}
          disabled={!dirty || update.isPending}
        >
          {update.isPending ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
