import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, ExternalLink, Download, Search, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useUpdateAgent, type Agent, type AgentSkill } from "@/hooks/use-agents";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

interface Props {
  agent: Agent;
}

interface IndexSkill {
  id: string;
  title: string;
  source: string;
  skillId: string;
  installsAllTime: number;
  installsTrending: number;
  installsHot: number;
  link: string;
  firstSeenAt: string;
}

interface SearchResult {
  skills: IndexSkill[];
  total: number;
  limit: number;
  offset: number;
}

interface SourceInfo {
  source: string;
  owner: string;
  skillCount: number;
  totalInstalls: number;
}

interface StatsResult {
  totalSkills: number;
  totalSources: number;
  totalOwners: number;
  indexLoaded: boolean;
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function AgentSkillsTab({ agent }: Props) {
  const update = useUpdateAgent();
  const [addOpen, setAddOpen] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const skills = agent.skills ?? [];

  // Search state
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sort, setSort] = useState<"allTime" | "trending" | "hot" | "newest">("allTime");
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [stats, setStats] = useState<StatsResult | null>(null);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Load sources for filter pills
  useEffect(() => {
    api<{ data: SourceInfo[]; total: number }>("/skills/sources?limit=20")
      .then((d) => setSources(d.data ?? []))
      .catch(() => {});
  }, []);

  // Load stats
  useEffect(() => {
    api<StatsResult>("/skills/stats")
      .then(setStats)
      .catch(() => {});
  }, []);

  // Search skills
  const doSearch = useCallback(
    (offset = 0) => {
      setLoading(true);
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (sourceFilter) params.set("source", sourceFilter);
      params.set("sort", sort);
      params.set("limit", "30");
      params.set("offset", String(offset));
      api<SearchResult>(`/skills?${params}`)
        .then((d) => {
          if (offset === 0) {
            setResults(d);
          } else {
            setResults((prev) =>
              prev
                ? { ...d, skills: [...prev.skills, ...d.skills] }
                : d
            );
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    },
    [debouncedSearch, sourceFilter, sort]
  );

  useEffect(() => {
    doSearch(0);
  }, [doSearch]);

  async function handleRemove(skillName: string) {
    try {
      await update.mutateAsync({
        id: agent.id,
        skills: skills.filter((s) => s.name !== skillName),
      });
      toast.success(`Removed skill "${skillName}"`);
    } catch {
      toast.error("Failed to remove skill");
    }
  }

  async function handleInstall(skill: AgentSkill) {
    try {
      await update.mutateAsync({
        id: agent.id,
        skills: [...skills, skill],
      });
      toast.success(`Installed skill "${skill.name}"`);
      setAddOpen(false);
    } catch {
      toast.error("Failed to install skill");
    }
  }

  async function handleInstallFromCatalog(t: IndexSkill) {
    if (skills.some((s) => s.name === t.title)) {
      toast.error(`Skill "${t.title}" is already installed`);
      return;
    }
    setInstalling(t.id);
    try {
      const parts = t.id.split("/");
      let source: string;
      if (parts.length >= 3) {
        source = `${parts[0]}/${parts[1]}@${parts.slice(2).join("/")}`;
      } else {
        source = t.id;
      }
      const skill = await fetchSkill(source);
      await handleInstall(skill);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to install skill"
      );
    } finally {
      setInstalling(null);
    }
  }

  const installedNames = new Set(skills.map((s) => s.name));
  const canLoadMore =
    results && results.offset + results.skills.length < results.total;

  return (
    <div className="flex flex-col gap-6">
      {/* Installed Skills */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">
            Installed Skills ({skills.length})
          </p>
          <p className="text-xs text-muted-foreground">
            Give your agent domain expertise with skill files.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-foreground"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="size-3.5" />
          Add from GitHub
        </Button>
      </div>

      {skills.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No skills installed. Browse the catalog below or add from GitHub.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {skills.map((skill) => (
            <Card key={skill.name}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-sm">{skill.name}</CardTitle>
                    <CardDescription className="font-mono text-xs">
                      {skill.source}
                    </CardDescription>
                  </div>
                  {skill.installed_at && (
                    <span className="text-xs text-muted-foreground">
                      {timeAgo(skill.installed_at)}
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pb-2">
                <pre className="rounded bg-muted p-3 text-xs text-muted-foreground max-h-32 overflow-y-auto whitespace-pre-wrap">
                  {skill.content.slice(0, 500)}
                  {skill.content.length > 500 ? "..." : ""}
                </pre>
              </CardContent>
              <CardFooter>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleRemove(skill.name)}
                >
                  <Trash2 className="mr-1.5 size-3.5" />
                  Remove
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Skills Catalog */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Skills Catalog</p>
            {stats && stats.indexLoaded && (
              <p className="text-[11px] text-muted-foreground">
                {stats.totalSkills.toLocaleString()} skills from{" "}
                {stats.totalOwners.toLocaleString()} authors
              </p>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
          <Input
            placeholder="Search 72k+ skills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-8 text-sm text-foreground"
          />
        </div>

        {/* Sort + Source filters */}
        <div className="flex flex-col gap-2">
          <div className="flex gap-1.5">
            {(["allTime", "trending", "hot", "newest"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                  sort === s
                    ? "bg-lime-400/20 text-lime-400"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {s === "allTime"
                  ? "All Time"
                  : s === "trending"
                    ? "Trending"
                    : s === "hot"
                      ? "Hot"
                      : "Newest"}
              </button>
            ))}
          </div>
        </div>

        {/* Results count */}
        {results && (
          <p className="text-[11px] text-muted-foreground">
            {results.total.toLocaleString()} results
            {loading && " · Loading..."}
          </p>
        )}

        {/* Grid */}
        <div className="grid grid-cols-2 gap-2">
          {results?.skills.map((t) => {
            const isInstalled = installedNames.has(t.title);
            const isLoading = installing === t.id;
            const installs =
              sort === "trending"
                ? t.installsTrending
                : sort === "hot"
                  ? t.installsHot
                  : t.installsAllTime;
            return (
              <button
                key={t.id}
                disabled={isInstalled || isLoading}
                onClick={() => handleInstallFromCatalog(t)}
                className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  isInstalled
                    ? "border-lime-400/30 bg-lime-400/5 opacity-60"
                    : "border-border hover:border-muted-foreground/50"
                }`}
              >
                <div className="flex items-center gap-2 w-full">
                  <span className="text-xs font-medium text-foreground truncate">
                    {t.title}
                  </span>
                  <Badge
                    variant="outline"
                    className="ml-auto shrink-0 text-[10px] px-1.5 py-0"
                  >
                    <Download className="size-2.5 mr-0.5" />
                    {formatInstalls(installs)}
                  </Badge>
                </div>
                <span className="text-[10px] text-muted-foreground/60 font-mono">
                  {t.source}
                </span>
                {isInstalled && (
                  <span className="text-[10px] text-lime-400">Installed</span>
                )}
                {isLoading && (
                  <span className="text-[10px] text-muted-foreground">
                    Installing...
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Load more */}
        {canLoadMore && (
          <Button
            variant="outline"
            size="sm"
            className="mx-auto gap-1.5 text-foreground"
            onClick={() => doSearch(results!.offset + results!.skills.length)}
            disabled={loading}
          >
            <ChevronDown className="size-3.5" />
            {loading ? "Loading..." : "Load more"}
          </Button>
        )}

        {results && results.skills.length === 0 && !loading && (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No skills found{search ? ` for "${search}"` : ""}
          </p>
        )}
      </div>

      <AddSkillDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        existingNames={skills.map((s) => s.name)}
        onInstall={handleInstall}
      />
    </div>
  );
}

function extractNameFromContent(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim().toLowerCase().replace(/\s+/g, "-") : null;
}

async function fetchSkill(source: string): Promise<AgentSkill> {
  const atIdx = source.indexOf("@");
  let owner: string, repo: string, skillName: string | undefined;

  if (atIdx !== -1) {
    const repoPath = source.slice(0, atIdx);
    skillName = source.slice(atIdx + 1);
    [owner, repo] = repoPath.split("/");
  } else {
    const parts = source.split("/");
    owner = parts[0];
    repo = parts[1];
  }

  if (!owner || !repo) {
    throw new Error("Invalid format. Use owner/repo or owner/repo@skill-name");
  }

  const urls = skillName
    ? [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/skills/${skillName}/SKILL.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/${skillName}/SKILL.md`,
      ]
    : [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/SKILL.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/main/skills/SKILL.md`,
      ];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const content = await res.text();
        const name = skillName || extractNameFromContent(content) || repo;
        return { name, source, content, installed_at: new Date().toISOString() };
      }
    } catch {
      continue;
    }
  }
  throw new Error("Could not find SKILL.md.");
}

interface AddSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
  onInstall: (skill: AgentSkill) => void;
}

function AddSkillDialog({
  open,
  onOpenChange,
  existingNames,
  onInstall,
}: AddSkillDialogProps) {
  const [source, setSource] = useState("");
  const [fetching, setFetching] = useState(false);
  const [preview, setPreview] = useState<AgentSkill | null>(null);
  const [error, setError] = useState("");

  function reset() {
    setSource("");
    setPreview(null);
    setError("");
    setFetching(false);
  }

  async function handleFetch() {
    setError("");
    setPreview(null);
    setFetching(true);
    try {
      const skill = await fetchSkill(source.trim());
      if (existingNames.includes(skill.name)) {
        setError(`Skill "${skill.name}" is already installed`);
      } else {
        setPreview(skill);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch skill");
    } finally {
      setFetching(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg border-border bg-card">
        <DialogHeader>
          <DialogTitle className="text-foreground">
            Add Skill from GitHub
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="text-sm text-foreground">GitHub Source</Label>
            <div className="flex gap-2">
              <Input
                placeholder="owner/repo or owner/repo@skill-name"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="flex-1 text-foreground"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && source.trim()) handleFetch();
                }}
              />
              <Button
                variant="outline"
                className="text-foreground"
                onClick={handleFetch}
                disabled={!source.trim() || fetching}
              >
                {fetching ? "Fetching..." : "Fetch"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Fetches SKILL.md from the GitHub repository
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {preview && (
            <div className="flex flex-col gap-3 rounded-lg border p-4">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {preview.name}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  {preview.source}
                </p>
              </div>
              <ScrollArea className="max-h-48">
                <pre className="rounded bg-muted p-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {preview.content.slice(0, 2000)}
                  {preview.content.length > 2000 ? "\n..." : ""}
                </pre>
              </ScrollArea>
              <Button
                className="bg-cta-gradient text-black font-medium hover:opacity-90"
                onClick={() => onInstall(preview)}
              >
                Install Skill
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
