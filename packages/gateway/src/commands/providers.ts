import { Command } from "commander";
import { initBackend, getFormat } from "../index.js";
import { formatOutput, type Column } from "../output/table.js";

const cols: Column[] = [
  { header: "PROVIDER", field: (p) => p.name },
  { header: "STATUS", field: (p) => p.available ? "✓ available" : "✗ unavailable" },
  { header: "MESSAGE", field: (p) => p.message ?? "" },
];

export function registerProviderCommands(parent: Command): void {
  const providers = parent.command("providers").aliases(["provider"]).description("Manage providers");

  providers.command("status")
    .description("Check availability of all container providers")
    .action(async () => {
      const b = await initBackend();
      const status = await b.providers.status();
      const rows = Object.entries(status).map(([name, s]) => ({
        name,
        available: s.available,
        message: s.message ?? "",
      }));
      formatOutput(getFormat(), rows, cols);
    });
}
