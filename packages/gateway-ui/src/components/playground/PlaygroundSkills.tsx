import { useState, useEffect, useCallback } from "react";
import { ChevronDown, Search, X, Loader2, Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { useAgent, useUpdateAgent } from "@/hooks/use-agents";
import { api } from "@/lib/api-client";
import { fetchSkill } from "@/lib/skills";
import { toast } from "sonner";

interface IndexSkill {
  id: string;
  title: string;
  source: string;
  installsAllTime: number;
}

interface SearchResult {
  skills: IndexSkill[];
  total: number;
}

interface Props {
  agentId: string | null;
}

export function PlaygroundSkills({ agentId }: Props) {
  const { data: agent } = useAgent(agentId);
  const update = useUpdateAgent();
  const skills = agent?.skills ?? [];

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const doSearch = useCallback(() => {
    if (!debouncedSearch) { setResults(null); return; }
    setLoading(true);
    const params = new URLSearchParams({ q: debouncedSearch, limit: "8", sort: "allTime" });
    api<SearchResult>(`/skills?${params}`)
      .then(setResults)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [debouncedSearch]);

  useEffect(() => { doSearch(); }, [doSearch]);

  async function handleInstall(t: IndexSkill) {
    if (!agent) return;
    if (skills.some(s => s.name === t.title)) {
      toast.error(`"${t.title}" is already installed`);
      return;
    }
    setInstalling(t.id);
    try {
      const parts = t.id.split("/");
      const source = parts.length >= 3
        ? `${parts[0]}/${parts[1]}@${parts.slice(2).join("/")}`
        : t.id;
      const skill = await fetchSkill(source);
      await update.mutateAsync({ id: agent.id, skills: [...skills, skill] });
      toast.success(`Installed "${skill.name}"`);
      setSearch("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to install");
    } finally {
      setInstalling(null);
    }
  }

  async function handleRemove(name: string) {
    if (!agent) return;
    try {
      await update.mutateAsync({ id: agent.id, skills: skills.filter(s => s.name !== name) });
      toast.success(`Removed "${name}"`);
    } catch {
      toast.error("Failed to remove skill");
    }
  }

  const installedNames = new Set(skills.map(s => s.name));

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors">
        Skills {skills.length > 0 && <span className="font-mono text-[10px] font-normal">{skills.length}</span>}
        <ChevronDown className="size-3.5 transition-transform data-[panel-open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 px-4 pb-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
            <Input
              placeholder="Search skills…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 pl-7 text-xs"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            )}
          </div>

          {/* Search results */}
          {debouncedSearch && (
            <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
              {loading && <p className="text-[10px] text-muted-foreground py-1">Searching…</p>}
              {results?.skills.map(t => (
                <div key={t.id} className="flex items-center justify-between py-1">
                  <span className={`text-xs truncate mr-2 ${installedNames.has(t.title) ? "text-muted-foreground" : "text-foreground"}`}>
                    {t.title}
                  </span>
                  {installedNames.has(t.title) ? (
                    <span className="text-[10px] text-muted-foreground shrink-0">installed</span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 text-[10px]"
                      disabled={installing === t.id}
                      onClick={() => handleInstall(t)}
                    >
                      {installing === t.id ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                    </Button>
                  )}
                </div>
              ))}
              {results && results.skills.length === 0 && !loading && (
                <p className="text-[10px] text-muted-foreground py-1">No results</p>
              )}
            </div>
          )}

          {/* Installed skills */}
          {skills.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {skills.map(s => (
                <div key={s.name} className="flex items-center justify-between py-1 group">
                  <div className="flex flex-col min-w-0 mr-2">
                    <span className="text-xs text-foreground truncate">{s.name}</span>
                    <span className="text-[10px] text-muted-foreground truncate">{s.source}</span>
                  </div>
                  <button
                    onClick={() => handleRemove(s.name)}
                    className="shrink-0 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : !debouncedSearch ? (
            <p className="text-[10px] text-muted-foreground">No skills installed</p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

