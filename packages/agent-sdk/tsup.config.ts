import { defineConfig } from "tsup";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Collect all .ts files under src/ as individual entry points.
// This preserves the file structure in dist/ so deep imports work.
function collectEntries(dir: string, base: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      entries.push(...collectEntries(full, base));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      entries.push(relative(base, full));
    }
  }
  return entries;
}

const srcDir = join(import.meta.dirname, "src");
const entries = collectEntries(srcDir, join(import.meta.dirname));

export default defineConfig({
  entry: entries,
  format: ["esm"],
  target: "node22",
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  // Don't bundle dependencies — they're in package.json dependencies
  external: [
    "libsql",
    "better-sqlite3",
    "drizzle-orm",
    "drizzle-orm/*",
    "ws",
    "zod",
    "@asteasolutions/zod-to-openapi",
    "@sentry/node",
    "ulid",
    "ioredis",
    "sharp",
  ],
});
