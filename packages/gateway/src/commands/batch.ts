import { Command } from "commander";
import { readFileSync } from "node:fs";
import { initBackend } from "../index.js";
import { printJSON } from "../output/format.js";

export function registerBatchCommand(parent: Command): void {
  parent.command("batch")
    .description("Execute batch operations (JSON from file or stdin)")
    .option("--file <path>", "JSON file with batch operations")
    .action(async (opts) => {
      const b = await initBackend();

      let data: string;
      if (opts.file) {
        data = readFileSync(opts.file, "utf-8");
      } else if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        data = Buffer.concat(chunks).toString("utf-8");
      } else {
        throw new Error("No input: use --file or pipe JSON to stdin");
      }

      const parsed = JSON.parse(data);
      const operations = parsed.operations ?? parsed;
      if (!Array.isArray(operations) || operations.length === 0) {
        throw new Error("No operations in batch");
      }

      const res = await b.batch.execute(operations);
      printJSON(res);
    });
}
