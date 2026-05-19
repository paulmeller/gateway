import { Command } from "commander";
import { initBackend } from "../index.js";

export function registerWorkerCommand(parent: Command): void {
  parent.command("worker")
    .description("Start a worker that polls and executes turns for self_hosted environments")
    .requiredOption("--environment <id>", "Environment ID to poll")
    .option("--provider <name>", "Container provider (default from env config)")
    .option("--poll-interval <ms>", "Poll interval in milliseconds", "5000")
    .option("--worker-id <id>", "Worker identifier (default: worker-<pid>)")
    .action(async (opts) => {
      // Initialize local backend (boots DB, runs migrations)
      await initBackend();

      const { startWorker } = await import("@agentstep/agent-sdk");
      await startWorker({
        environmentId: opts.environment,
        provider: opts.provider,
        pollIntervalMs: parseInt(opts.pollInterval, 10),
        workerId: opts.workerId,
      });
    });
}
