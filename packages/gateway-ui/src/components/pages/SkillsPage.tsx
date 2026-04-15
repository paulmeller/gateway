import { useState, useEffect, useCallback } from "react";
import { Search, ChevronDown, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

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

interface StatsResult {
  totalSkills: number;
  totalSources: number;
  totalOwners: number;
  indexLoaded: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
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

function buildInstallInstructions(skill: IndexSkill): string {
  const parts = skill.id.split("/");
  let source: string;
  if (parts.length >= 3) {
    source = `${parts[0]}/${parts[1]}@${parts.slice(2).join("/")}`;
  } else {
    source = skill.id;
  }
  return `# Via AgentStep Gateway\n# Open the agent you want to add this skill to, go to the Skills tab,\n# and search for "${skill.title}" in the catalog.\n\n# Or install via CLI:\nagentstep skills install ${source}\n\n# GitHub source:\n${skill.link || `https://github.com/${source.replace("@", "/tree/main/skills/")}`}`;
}

// ─── Skill Detail Dialog ──────────────────────────────────────────────────────

interface SkillDetailDialogProps {
  skill: IndexSkill | null;
  sort: "allTime" | "trending" | "hot" | "newest";
  onClose: () => void;
}

function SkillDetailDialog({ skill, sort, onClose }: SkillDetailDialogProps) {
  if (!skill) return null;

  const installs =
    sort === "trending"
      ? skill.installsTrending
      : sort === "hot"
        ? skill.installsHot
        : skill.installsAllTime;

  return (
    <Dialog open={!!skill} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg border-border bg-card">
        <DialogHeader>
          <DialogTitle className="text-foreground pr-6">{skill.title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {/* Meta row */}
          <div className="flex items-center gap-3 flex-wrap">
            <Badge variant="outline" className="font-mono text-[11px] text-foreground">
              {skill.source}
            </Badge>
            <Badge variant="outline" className="text-[11px] text-foreground gap-1">
              <Download className="size-2.5" />
              {formatInstalls(installs)} installs
            </Badge>
            {skill.firstSeenAt && (
              <span className="text-[11px] text-muted-foreground">
                Added {timeAgo(skill.firstSeenAt)}
              </span>
            )}
          </div>

          {/* Install instructions */}
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-foreground">Install instructions</p>
            <ScrollArea className="max-h-52">
              <pre className="rounded-lg bg-muted p-3 text-[11px] text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
                {buildInstallInstructions(skill)}
              </pre>
            </ScrollArea>
          </div>

          {/* Link to source */}
          {skill.link && (
            <a
              href={skill.link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-lime-600 dark:text-lime-400 hover:underline"
            >
              View on skills.sh →
            </a>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Skills Page ──────────────────────────────────────────────────────────────

export function SkillsPage() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sort, setSort] = useState<"allTime" | "trending" | "hot" | "newest">("allTime");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<IndexSkill | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

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
      params.set("sort", sort);
      params.set("limit", "30");
      params.set("offset", String(offset));
      api<SearchResult>(`/skills?${params}`)
        .then((d) => {
          if (offset === 0) {
            setResults(d);
          } else {
            setResults((prev) =>
              prev ? { ...d, skills: [...prev.skills, ...d.skills] } : d
            );
          }
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    },
    [debouncedSearch, sort]
  );

  useEffect(() => {
    doSearch(0);
  }, [doSearch]);

  const canLoadMore =
    results && results.offset + results.skills.length < results.total;

  const SORT_LABELS: Record<string, string> = {
    allTime: "All Time",
    trending: "Trending",
    hot: "Hot",
    newest: "Newest",
  };

  return (
    <div className="px-6 py-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">Skills Catalog</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Browse 72k+ skills from{" "}
          <a
            href="https://skills.sh"
            target="_blank"
            rel="noopener noreferrer"
            className="text-lime-600 dark:text-lime-400 hover:underline"
          >
            skills.sh
          </a>
          {stats && stats.indexLoaded && (
            <>
              {" "}— {stats.totalSkills.toLocaleString()} skills from{" "}
              {stats.totalOwners.toLocaleString()} authors
            </>
          )}
        </p>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
        <Input
          placeholder="Search 72k+ skills..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 pl-8 pr-8 text-sm text-foreground"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* Sort buttons */}
      <div className="mb-4 flex items-center gap-1.5">
        {(["allTime", "trending", "hot", "newest"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSort(s)}
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              sort === s
                ? "bg-lime-400/20 text-lime-600 dark:text-lime-400"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {SORT_LABELS[s]}
          </button>
        ))}
        {results && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {results.total.toLocaleString()} results
            {loading && " · Loading..."}
          </span>
        )}
      </div>

      {/* Loading skeleton (initial load) */}
      {loading && !results && (
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="h-14 rounded-lg border border-border bg-muted/30 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Results grid */}
      {results && (
        <div className="grid grid-cols-2 gap-2">
          {results.skills.map((skill) => {
            const installs =
              sort === "trending"
                ? skill.installsTrending
                : sort === "hot"
                  ? skill.installsHot
                  : skill.installsAllTime;
            return (
              <button
                key={skill.id}
                onClick={() => setSelectedSkill(skill)}
                className="flex flex-col items-start gap-1 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-muted-foreground/50 hover:bg-accent/30"
              >
                <div className="flex items-center gap-2 w-full">
                  <span className="text-xs font-medium text-foreground truncate">
                    {skill.title}
                  </span>
                  <Badge
                    variant="outline"
                    className="ml-auto shrink-0 text-[10px] px-1.5 py-0 text-foreground"
                  >
                    <Download className="size-2.5 mr-0.5" />
                    {formatInstalls(installs)}
                  </Badge>
                </div>
                <span className="text-[10px] text-muted-foreground/70 font-mono truncate w-full">
                  {skill.source}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {results && results.skills.length === 0 && !loading && (
        <div className="py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No skills found{search ? ` for "${search}"` : ""}
          </p>
        </div>
      )}

      {/* Load more */}
      {canLoadMore && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-foreground"
            onClick={() => doSearch(results!.offset + results!.skills.length)}
            disabled={loading}
          >
            <ChevronDown className="size-3.5" />
            {loading ? "Loading..." : "Load more"}
          </Button>
        </div>
      )}

      {/* Skill detail dialog */}
      <SkillDetailDialog
        skill={selectedSkill}
        sort={sort}
        onClose={() => setSelectedSkill(null)}
      />
    </div>
  );
}
