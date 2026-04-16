import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function registerVersionCommand(parent: Command): void {
  parent.command("version")
    .description("Print the CLI version")
    .action(() => {
      // Try multiple candidate paths because the CLI is bundled: running
      // from `dist/gateway.js` gives `__dirname = packages/gateway/dist/`,
      // but running the unbundled source gives `packages/gateway/src/commands/`.
      // Also support the monorepo CWD fallback.
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const candidates = [
        join(__dirname, "../package.json"),        // bundled: dist/ → package.json
        join(__dirname, "../../package.json"),     // src/commands/ → src/ → package.json
        join(process.cwd(), "package.json"),
      ];
      for (const p of candidates) {
        try {
          const pkg = JSON.parse(readFileSync(p, "utf-8"));
          // Only accept if it's the gateway package (monorepo CWD might
          // match the root package.json, which has a different name).
          if (pkg.name === "@agentstep/gateway" && typeof pkg.version === "string") {
            console.log(`gateway ${pkg.version}`);
            return;
          }
        } catch { /* try next */ }
      }
      console.log("gateway dev");
    });
}
