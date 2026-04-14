import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Read the single-file HTML output from Vite
const html = readFileSync(
  resolve(ROOT, "packages/gateway-ui/dist/index.html"),
  "utf-8",
);

// Escape for JS template literal
const escaped = html
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

// Content hash for ETag
const hash = createHash("md5").update(html).digest("hex").slice(0, 8);

const output = `// AUTO-GENERATED — do not edit. Run: npm run build:ui
const HTML_TEMPLATE = \`${escaped}\`;
const UI_VERSION = "${hash}";

export async function handleGetUI(opts?: { apiKey?: string; version?: string }): Promise<Response> {
  let body = HTML_TEMPLATE;
  const scripts: string[] = [];
  if (opts?.apiKey) {
    const safe = opts.apiKey
      .replace(/\\\\/g, "\\\\\\\\")
      .replace(/"/g, '\\\\"')
      .replace(/</g, "\\\\x3c")
      .replace(/>/g, "\\\\x3e")
      .replace(/\\n/g, "\\\\n");
    scripts.push(\`window.__MA_API_KEY__="\${safe}";\`);
  }
  if (opts?.version) {
    scripts.push(\`window.__MA_VERSION__="\${opts.version}";\`);
  }
  body = body.replace(
    "__INJECT__",
    scripts.length > 0 ? \`<script>\${scripts.join("")}</script>\` : "",
  );
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      ETag: \`"\${UI_VERSION}"\`,
    },
  });
}
`;

const outPath = resolve(ROOT, "packages/agent-sdk/src/handlers/ui.ts");
writeFileSync(outPath, output, "utf-8");
console.log(`[build-ui] wrote ${outPath} (hash: ${hash}, ${(html.length / 1024).toFixed(0)} KB)`);
