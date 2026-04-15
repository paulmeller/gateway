import type { AgentSkill } from "@/hooks/use-agents";

export function extractNameFromContent(content: string): string | null {
  // Try frontmatter name field first
  const fmMatch = /^name:\s*(.+)$/m.exec(content);
  if (fmMatch) return fmMatch[1].trim();
  // Fall back to first heading
  const hMatch = content.match(/^#\s+(.+)$/m);
  return hMatch ? hMatch[1].trim().toLowerCase().replace(/\s+/g, "-") : null;
}

export async function fetchSkill(source: string): Promise<AgentSkill> {
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
  throw new Error(`Could not find SKILL.md for "${source}"`);
}
