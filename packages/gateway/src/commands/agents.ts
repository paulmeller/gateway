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
}
