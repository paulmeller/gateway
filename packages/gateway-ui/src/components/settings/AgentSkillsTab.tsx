import { useState, useEffect } from "react";
import { Plus, Trash2, ExternalLink, Download, TrendingUp } from "lucide-react";
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

interface TrendingSkill {
  id: string;
  title: string;
  source: string;
  installs: number;
  link: string;
  description: string;
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
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function AgentSkillsTab({ agent }: Props) {
  const update = useUpdateAgent();
  const [addOpen, setAddOpen] = useState(false);
  const [trending, setTrending] = useState<TrendingSkill[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);
  const skills = agent.skills ?? [];

  useEffect(() => {
    api<{ skills: TrendingSkill[] }>("/skills/catalog?leaderboard=trending&limit=12")
      .then((d) => setTrending(d.skills ?? []))
      .catch(() => {});
  }, []);

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

  async function handleInstallTrending(t: TrendingSkill) {
    if (skills.some((s) => s.name === t.title)) {
      toast.error(`Skill "${t.title}" is already installed`);
      return;
    }
    setInstalling(t.id);
    try {
      // Skill id format: "owner/repo/skill-name" → source: "owner/repo@skill-name"
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
      toast.error(err instanceof Error ? err.message : "Failed to install skill");
    } finally {
      setInstalling(null);
    }
  }

  const installedNames = new Set(skills.map((s) => s.name));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">Installed Skills</p>
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
            No skills installed. Browse popular skills below or add from GitHub.
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

      {/* Trending Skills */}
      {trending.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="size-4 text-lime-400" />
            <p className="text-sm font-medium text-foreground">Popular Skills</p>
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-xs text-lime-400 hover:underline inline-flex items-center gap-1"
            >
              Browse all <ExternalLink className="size-3" />
            </a>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {trending.map((t) => {
              const isInstalled = installedNames.has(t.title);
              const isLoading = installing === t.id;
              return (
                <button
                  key={t.id}
                  disabled={isInstalled || isLoading}
                  onClick={() => handleInstallTrending(t)}
                  className={`flex flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    isInstalled
                      ? "border-lime-400/30 bg-lime-400/5 opacity-60"
                      : "border-border hover:border-muted-foreground/50"
                  }`}
                >
                  <div className="flex items-center gap-2 w-full">
                    <span className="text-xs font-medium text-foreground truncate">{t.title}</span>
                    <Badge variant="outline" className="ml-auto shrink-0 text-[10px] px-1.5 py-0">
                      <Download className="size-2.5 mr-0.5" />
                      {formatInstalls(t.installs)}
                    </Badge>
                  </div>
                  <span className="text-[11px] text-muted-foreground line-clamp-2">
                    {t.description.split(". ")[0]}
                  </span>
                  {isInstalled && (
                    <span className="text-[10px] text-lime-400">Installed</span>
                  )}
                  {isLoading && (
                    <span className="text-[10px] text-muted-foreground">Installing...</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

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
  // Support both "owner/repo@skill" and "owner/repo" formats
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
        return {
          name,
          source,
          content,
          installed_at: new Date().toISOString(),
        };
      }
    } catch {
      continue;
    }
  }
  throw new Error(
    "Could not find SKILL.md. Make sure the repo has a SKILL.md file."
  );
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
          <DialogTitle className="text-foreground">Add Skill from GitHub</DialogTitle>
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

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

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
