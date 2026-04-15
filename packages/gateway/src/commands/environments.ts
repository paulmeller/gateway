import { Command } from "commander";
import ora from "ora";
import { initBackend, getBackend, getFormat } from "../index.js";
import { formatOutput, type Column } from "../output/table.js";

const cols: Column[] = [
  { header: "ID", field: (e) => e.id },
  { header: "NAME", field: (e) => e.name },
  { header: "STATE", field: (e) => e.state },
  { header: "CREATED", field: (e) => e.created_at },
];

export function registerEnvironmentCommands(parent: Command): void {
  const envs = parent.command("environments").aliases(["envs", "env"]).description("Manage environments");

  envs.command("create")
    .requiredOption("--name <name>", "Environment name")
    .option("--provider <provider>", "Provider: sprites, docker, apple-container, podman, e2b, vercel, daytona, fly, modal", "sprites")
    .option("--packages-npm <pkgs>", "npm packages (comma-separated)")
    .option("--packages-pip <pkgs>", "pip packages (comma-separated)")
    .option("--packages-apt <pkgs>", "apt packages (comma-separated)")
    .action(async (opts) => {
      const b = await initBackend();
      const config: Record<string, unknown> = { type: "cloud", provider: opts.provider };
      const packages: Record<string, string[]> = {};
      if (opts.packagesNpm) packages.npm = opts.packagesNpm.split(",");
      if (opts.packagesPip) packages.pip = opts.packagesPip.split(",");
      if (opts.packagesApt) packages.apt = opts.packagesApt.split(",");
      if (Object.keys(packages).length > 0) config.packages = packages;
      const env = await b.environments.create({ name: opts.name, config });
      formatOutput(getFormat(), env, cols);
    });

  envs.command("list")
    .option("--limit <n>", "Max items", "20")
    .option("--order <order>", "Sort: asc, desc", "desc")
    .option("--include-archived", "Include archived")
    .action(async (opts) => {
      const b = await initBackend();
      const res = await b.environments.list({ limit: Number(opts.limit), order: opts.order, include_archived: opts.includeArchived });
      formatOutput(getFormat(), res.data, cols);
    });

  envs.command("get <id>").action(async (id) => {
    const b = await initBackend();
    const env = await b.environments.get(id);
    formatOutput(getFormat(), env, cols);
  });

  envs.command("delete <id>").action(async (id) => {
    const b = await initBackend();
    const res = await b.environments.delete(id);
    console.log(`Deleted environment ${res.id}`);
  });

  envs.command("archive <id>").action(async (id) => {
    const b = await initBackend();
    await b.environments.archive(id);
    console.log(`Archived environment ${id}`);
  });

  envs.command("wait <id>")
    .option("--timeout <seconds>", "Max wait time", "120")
    .option("--interval <seconds>", "Poll interval", "2")
    .action(async (id, opts) => {
      const b = await initBackend();
      const timeout = Number(opts.timeout) * 1000;
      const interval = Number(opts.interval) * 1000;
      await waitForEnvironment(b, id, timeout, interval);
    });
}

export async function waitForEnvironment(b: ReturnType<typeof getBackend>, id: string, timeout: number, interval: number): Promise<void> {
  const spinner = ora("Waiting for environment to be ready...").start();
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const env = await b.environments.get(id);
    if (env.state === "ready") {
      spinner.succeed(`Environment ${id} is ready`);
      return;
    }
    if (env.state === "failed") {
      spinner.fail(`Environment ${id} setup failed: ${env.state_message ?? "unknown error"}`);
      throw new Error("Environment setup failed");
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  spinner.fail(`Timeout: environment ${id} still not ready`);
  throw new Error("Timeout waiting for environment");
}
