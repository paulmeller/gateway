import { Command } from "commander";
import { initBackend } from "../index.js";

function parseLookback(duration: string): number {
  const match = duration.match(/^(\d+)(h|d|m|s)$/);
  if (!match) {
    throw new Error(`Invalid lookback duration: "${duration}". Use format like 24h, 7d, 30m.`);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

export function registerDreamCommand(parent: Command): void {
  parent.command("dream")
    .description("Review recent sessions and curate a memory store")
    .requiredOption("--memory-store <id>", "Memory store ID to curate")
    .option("--lookback <duration>", "How far back to look (e.g., 24h, 7d)", "24h")
    .option("--dry-run", "Show proposed changes without applying", false)
    .option("--api-key <key>", "Anthropic API key (or set ANTHROPIC_API_KEY)")
    .action(async (opts) => {
      // Ensure local backend is initialized (DB ready)
      await initBackend();

      const lookbackMs = parseLookback(opts.lookback);

      // Dynamic import to avoid pulling agent-sdk into the top-level module graph
      // when other commands are invoked.
      const { reviewSessions } = await import("@agentstep/agent-sdk");

      console.log(`Dreaming: reviewing sessions from the last ${opts.lookback}...`);
      console.log(`Memory store: ${opts.memoryStore}`);
      if (opts.dryRun) console.log("Mode: dry-run (no changes will be applied)");
      console.log("");

      try {
        const result = await reviewSessions({
          storeId: opts.memoryStore,
          lookbackMs,
          dryRun: opts.dryRun,
          apiKey: opts.apiKey,
        });

        console.log(`Sessions analyzed: ${result.sessionCount}`);
        console.log(`Proposed changes: ${result.proposedChanges.length}`);
        console.log("");

        if (result.proposedChanges.length === 0) {
          console.log("No memory changes proposed.");
          return;
        }

        for (const change of result.proposedChanges) {
          const icon = change.operation === "create" ? "+" : change.operation === "update" ? "~" : "-";
          console.log(`  [${icon}] ${change.operation.toUpperCase()} ${change.path}`);
          console.log(`      Reason: ${change.reason}`);
          if (change.content && opts.dryRun) {
            const preview = change.content.length > 200
              ? change.content.slice(0, 200) + "..."
              : change.content;
            console.log(`      Content: ${preview}`);
          }
          console.log("");
        }

        if (result.applied) {
          console.log("Changes applied to memory store.");
        } else if (opts.dryRun) {
          console.log("Dry-run complete. Use without --dry-run to apply changes.");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Dream failed: ${msg}`);
        process.exit(1);
      }
    });
}
