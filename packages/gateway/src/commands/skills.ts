import { Command } from "commander";
import { initBackend, getFormat } from "../index.js";
import { formatOutput, type Column } from "../output/table.js";

const skillCols: Column[] = [
  { header: "TITLE", field: (s) => s.title },
  { header: "SOURCE", field: (s) => s.source },
  { header: "INSTALLS", field: (s) => String(s.installsAllTime ?? s.installs ?? 0) },
];

export function registerSkillsCommands(parent: Command): void {
  const skills = parent.command("skills").aliases(["skill"]).description("Browse the skills catalog");

  skills.command("search [query]")
    .description("Search skills catalog")
    .option("--sort <sort>", "Sort: allTime, trending, hot, newest", "allTime")
    .option("--limit <n>", "Max results", "20")
    .option("--source <source>", "Filter by source repo")
    .action(async (query, opts) => {
      const b = await initBackend();
      const res = await b.skills.search({
        q: query,
        sort: opts.sort,
        limit: Number(opts.limit),
        source: opts.source,
      });
      console.log(`${res.total} results${query ? ` for "${query}"` : ""}\n`);
      formatOutput(getFormat(), res.skills, skillCols);
    });

  skills.command("stats")
    .description("Show skills catalog statistics")
    .action(async () => {
      const b = await initBackend();
      const stats = await b.skills.stats();
      console.log(`Skills:  ${stats.totalSkills.toLocaleString()}`);
      console.log(`Sources: ${stats.totalSources.toLocaleString()}`);
      console.log(`Authors: ${stats.totalOwners.toLocaleString()}`);
      if (stats.updatedAt) console.log(`Updated: ${stats.updatedAt}`);
      if (!stats.indexLoaded) console.log(`\nNote: Full index not loaded yet. Run "skills search" to trigger.`);
    });

  skills.command("sources")
    .description("List top skill sources by installs")
    .option("--limit <n>", "Max results", "20")
    .action(async (opts) => {
      const b = await initBackend();
      const res = await b.skills.sources({ limit: Number(opts.limit) });
      formatOutput(getFormat(), res.data, [
        { header: "SOURCE", field: (s) => s.source },
        { header: "SKILLS", field: (s) => String(s.skillCount) },
        { header: "INSTALLS", field: (s) => String(s.totalInstalls) },
      ]);
    });
}
