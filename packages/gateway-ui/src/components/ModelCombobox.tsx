import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useModels, type ModelEntry } from "@/hooks/use-models";
import { cn } from "@/lib/utils";

interface Props {
  engine: string;
  value: string;
  onChange: (value: string) => void;
}

/** Provider display names for grouping */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  ollama: "Ollama (local)",
  openrouter: "OpenRouter",
  unknown: "Other",
};

/** Group models by provider */
function groupByProvider(models: ModelEntry[]): Record<string, ModelEntry[]> {
  const groups: Record<string, ModelEntry[]> = {};
  for (const m of models) {
    const key = m.provider;
    if (!groups[key]) groups[key] = [];
    groups[key].push(m);
  }
  return groups;
}

/** Format context window for display */
function formatContext(tokens?: number): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function ModelCombobox({ engine, value, onChange }: Props) {
  const { data: models, isLoading, isError } = useModels(engine);
  const [open, setOpen] = useState(false);

  // Fallback to a plain text input if fetch fails
  if (isError) {
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter model ID"
        className="h-10 w-full text-foreground"
      />
    );
  }

  // Resolve the engine-specific ID for display
  const resolveEngineId = (model: ModelEntry): string => {
    return model.engines[engine] ?? model.id;
  };

  // Find the currently selected model for display
  const selectedModel = models?.find(
    (m) => resolveEngineId(m) === value || m.id === value,
  );
  const displayValue = selectedModel
    ? resolveEngineId(selectedModel)
    : value || "Select a model";

  const grouped = models ? groupByProvider(models) : {};

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        role="combobox"
        aria-expanded={open}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-lg border border-border bg-background px-2.5 text-sm text-foreground",
          "hover:bg-muted dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        )}
      >
        <span className="truncate">{displayValue}</span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search models..." />
          <CommandList>
            <CommandEmpty>
              {isLoading ? "Loading models..." : "No models found."}
            </CommandEmpty>
            {Object.entries(grouped).map(([provider, providerModels]) => (
              <CommandGroup
                key={provider}
                heading={PROVIDER_LABELS[provider] ?? provider}
              >
                {providerModels.map((model) => {
                  const engineId = resolveEngineId(model);
                  const isSelected = engineId === value || model.id === value;
                  const ctx = formatContext(model.context_window);
                  return (
                    <CommandItem
                      key={`${model.provider}-${model.id}`}
                      value={`${model.provider} ${model.id} ${engineId}`}
                      data-checked={isSelected || undefined}
                      onSelect={() => {
                        onChange(engineId);
                        setOpen(false);
                      }}
                    >
                      <span className="truncate">{engineId}</span>
                      <span className="ml-auto flex items-center gap-1.5">
                        {model.local && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                            Local
                          </Badge>
                        )}
                        {ctx && (
                          <span className="text-xs text-muted-foreground">{ctx}</span>
                        )}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
