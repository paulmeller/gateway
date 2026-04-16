/**
 * Entry point for the Hono adapter.
 *
 * Loads .env from the project root (two levels up from packages/gateway-hono/),
 * then starts the HTTP server on the configured port.
 */
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from monorepo root (CWD is packages/gateway-hono/ under npm workspaces)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: resolve(root, ".env") });

// Default DB to monorepo root so dev server shares data with CLI
if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = resolve(root, "data/managed-agents.db");
}

import { serve } from "@hono/node-server";
import app from "./index";

const port = Number(process.env.PORT ?? 4000);
// Loopback default mirrors `gateway serve` — dev server is not a public
// artifact. Pass HOST=0.0.0.0 to expose; the UI handler won't inject
// the API key for non-loopback requests regardless.
const hostname = process.env.HOST ?? "127.0.0.1";

console.log(`[hono] starting on http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${port}`);
serve({ fetch: app.fetch, port, hostname });
