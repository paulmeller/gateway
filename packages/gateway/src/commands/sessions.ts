import { Command } from "commander";
import { initBackend, getFormat } from "../index.js";
import { formatOutput, type Column } from "../output/table.js";

const cols: Column[] = [
  { header: "ID", field: (s) => s.id },
  { header: "STATUS", field: (s) => s.status },
  { header: "TURNS", field: (s) => String(s.stats?.turn_count ?? 0) },
  { header: "COST", field: (s) => `$${(s.usage?.cost_usd ?? 0).toFixed(4)}` },
  { header: "CREATED", field: (s) => s.created_at },
];

const detail: Column[] = [
  ...cols,
  { header: "ENVIRONMENT", field: (s) => s.environment_id },
  { header: "TOOL CALLS", field: (s) => String(s.stats?.tool_calls_count ?? 0) },
  { header: "INPUT TOKENS", field: (s) => String(s.usage?.input_tokens ?? 0) },
  { header: "OUTPUT TOKENS", field: (s) => String(s.usage?.output_tokens ?? 0) },
];

export function registerSessionCommands(parent: Command): void {
  const sessions = parent.command("sessions").aliases(["sess", "session"]).description("Manage sessions");

  sessions.command("create")
    .requiredOption("--agent <id>", "Agent ID")
    .requiredOption("--env <id>", "Environment ID")
    .option("--title <title>", "Session title")
    .option("--agent-version <n>", "Agent version")
    .option("--max-budget <usd>", "Max budget in USD")
    .action(async (opts) => {
      const b = await initBackend();
      const agent = opts.agentVersion
        ? { id: opts.agent, version: Number(opts.agentVersion), type: "agent" }
        : opts.agent;
      const session = await b.sessions.create({
        agent,
        environment_id: opts.env,
        title: opts.title,
        max_budget_usd: opts.maxBudget ? Number(opts.maxBudget) : undefined,
      });
      formatOutput(getFormat(), session, detail);
    });

  sessions.command("list")
    .option("--limit <n>", "Max items", "20")
    .option("--order <order>", "Sort: asc, desc", "desc")
    .option("--agent-id <id>", "Filter by agent")
    .option("--env-id <id>", "Filter by environment")
    .option("--status <status>", "Filter: idle, running, terminated")
    .option("--include-archived", "Include archived")
    .action(async (opts) => {
      const b = await initBackend();
      const res = await b.sessions.list({
        limit: Number(opts.limit), order: opts.order,
        agent_id: opts.agentId, environment_id: opts.envId,
        status: opts.status, include_archived: opts.includeArchived,
      });
      formatOutput(getFormat(), res.data, cols);
    });

  sessions.command("get <id>").action(async (id) => {
    const b = await initBackend();
    const session = await b.sessions.get(id);
    formatOutput(getFormat(), session, detail);
  });

  sessions.command("update <id>")
    .option("--title <title>", "New title")
    .action(async (id, opts) => {
      const b = await initBackend();
      const input: Record<string, unknown> = {};
      if (opts.title !== undefined) input.title = opts.title;
      const session = await b.sessions.update(id, input);
      formatOutput(getFormat(), session, detail);
    });

  sessions.command("delete <id>").action(async (id) => {
    const b = await initBackend();
    const res = await b.sessions.delete(id);
    console.log(`Deleted session ${res.id}`);
  });

  sessions.command("archive <id>").action(async (id) => {
    const b = await initBackend();
    await b.sessions.archive(id);
    console.log(`Archived session ${id}`);
  });

  sessions.command("stream <id>")
    .option("--after-seq <n>", "Start after this sequence number")
    .option("--follow", "Keep streaming (don't stop on idle)")
    .action(async (id, opts) => {
      const b = await initBackend();
      const afterSeq = opts.afterSeq ? Number(opts.afterSeq) : undefined;

      // Clean exit on Ctrl+C
      let stopped = false;
      process.on("SIGINT", () => { stopped = true; });

      for await (const evt of b.events.stream(id, afterSeq)) {
        if (stopped) break;
        console.log(JSON.stringify(evt, null, 2));
        if (!opts.follow && (evt.type === "session.status_idle" || evt.type === "session.status_terminated")) {
          break;
        }
      }
    });

  sessions.command("threads <id>")
    .option("--limit <n>", "Max items", "20")
    .action(async (id, opts) => {
      const b = await initBackend();
      const res = await b.sessions.threads(id, { limit: Number(opts.limit) });
      formatOutput(getFormat(), res.data, cols);
    });
}
