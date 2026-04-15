import { Command } from "commander";
import { initBackend, getFormat } from "../index.js";
import { formatOutput, type Column } from "../output/table.js";

const cols: Column[] = [
  { header: "ID", field: (a) => a.id },
  { header: "NAME", field: (a) => a.name },
  { header: "MODEL", field: (a) => a.model },
  { header: "ENGINE", field: (a) => a.engine },
  { header: "VERSION", field: (a) => `v${a.version}` },
];

const detail: Column[] = [
  ...cols,
  { header: "CONFIRMATION", field: (a) => String(a.confirmation_mode) },
  { header: "CREATED", field: (a) => a.created_at },
];

export function registerAgentCommands(parent: Command): void {
  const agents = parent.command("agents").aliases(["agent"]).description("Manage agents");

  agents.command("create")
    .requiredOption("--name <name>", "Agent name")
    .requiredOption("--model <model>", "Model identifier")
    .option("--system <prompt>", "System prompt")
    .option("--engine <engine>", "Agent harness: claude, opencode, codex, anthropic", "claude")
    .option("--confirmation-mode", "Enable tool confirmation")
    .action(async (opts) => {
      const b = await initBackend();
      const agent = await b.agents.create({
        name: opts.name,
        model: opts.model,
        system: opts.system,
        engine: opts.engine,
        confirmation_mode: opts.confirmationMode,
      });
      formatOutput(getFormat(), agent, detail);
    });

  agents.command("list")
    .option("--limit <n>", "Max items", "20")
    .option("--order <order>", "Sort: asc, desc", "desc")
    .option("--include-archived", "Include archived")
    .action(async (opts) => {
      const b = await initBackend();
      const res = await b.agents.list({ limit: Number(opts.limit), order: opts.order, include_archived: opts.includeArchived });
      formatOutput(getFormat(), res.data, cols);
    });

  agents.command("get <id>")
    .option("--version <n>", "Specific version")
    .action(async (id, opts) => {
      const b = await initBackend();
      const agent = await b.agents.get(id, opts.version ? Number(opts.version) : undefined);
      formatOutput(getFormat(), agent, detail);
    });

  agents.command("update <id>")
    .option("--name <name>", "New name")
    .option("--model <model>", "New model")
    .option("--system <prompt>", "New system prompt")
    .action(async (id, opts) => {
      const b = await initBackend();
      const input: Record<string, unknown> = {};
      if (opts.name) input.name = opts.name;
      if (opts.model) input.model = opts.model;
      if (opts.system) input.system = opts.system;
      const agent = await b.agents.update(id, input);
      formatOutput(getFormat(), agent, detail);
    });

  agents.command("delete <id>")
    .action(async (id) => {
      const b = await initBackend();
      const res = await b.agents.delete(id);
      console.log(`Deleted agent ${res.id}`);
    });

  // --- Skills subcommands ---

  agents.command("skills <id>")
    .description("List installed skills on an agent")
    .action(async (id) => {
      const b = await initBackend();
      const agent = await b.agents.get(id);
      const skills = agent.skills ?? [];
      if (skills.length === 0) {
        console.log("No skills installed.");
        return;
      }
      formatOutput(getFormat(), skills, [
        { header: "NAME", field: (s) => s.name },
        { header: "SOURCE", field: (s) => s.source },
        { header: "INSTALLED", field: (s) => s.installed_at ?? "" },
      ]);
    });

  agents.command("add-skill <id> <source>")
    .description("Install a skill from GitHub (owner/repo or owner/repo@skill-name)")
    .action(async (id, source) => {
      const b = await initBackend();
      const agent = await b.agents.get(id);
      const existing = agent.skills ?? [];

      // Fetch SKILL.md from GitHub
      const skill = await fetchSkillFromGitHub(source);
      if (existing.some((s: any) => s.name === skill.name)) {
        console.error(`Skill "${skill.name}" is already installed.`);
        process.exit(1);
      }

      await b.agents.update(id, { skills: [...existing, skill] });
      console.log(`Installed skill "${skill.name}" from ${source}`);
    });

  agents.command("remove-skill <id> <skill-name>")
    .description("Remove an installed skill by name")
    .action(async (id, skillName) => {
      const b = await initBackend();
      const agent = await b.agents.get(id);
      const existing = agent.skills ?? [];
      const filtered = existing.filter((s: any) => s.name !== skillName);
      if (filtered.length === existing.length) {
        console.error(`Skill "${skillName}" not found.`);
        process.exit(1);
      }
      await b.agents.update(id, { skills: filtered });
      console.log(`Removed skill "${skillName}"`);
    });
}

async function fetchSkillFromGitHub(source: string): Promise<{ name: string; source: string; content: string; installed_at: string }> {
  const atIdx = source.indexOf("@");
  let owner: string, repo: string, skillName: string | undefined;
  if (atIdx !== -1) {
    [owner, repo] = source.slice(0, atIdx).split("/");
    skillName = source.slice(atIdx + 1);
  } else {
    [owner, repo] = source.split("/");
  }
  if (!owner || !repo) throw new Error("Invalid format. Use owner/repo or owner/repo@skill-name");

  const urls = skillName
    ? [`https://raw.githubusercontent.com/${owner}/${repo}/main/skills/${skillName}/SKILL.md`,
       `https://raw.githubusercontent.com/${owner}/${repo}/main/${skillName}/SKILL.md`]
    : [`https://raw.githubusercontent.com/${owner}/${repo}/main/SKILL.md`,
       `https://raw.githubusercontent.com/${owner}/${repo}/main/skills/SKILL.md`];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const content = await res.text();
        const match = content.match(/^#\s+(.+)$/m);
        const name = skillName || (match ? match[1].trim().toLowerCase().replace(/\s+/g, "-") : repo);
        return { name, source, content, installed_at: new Date().toISOString() };
      }
    } catch { continue; }
  }
  throw new Error("Could not find SKILL.md in repository.");
}
