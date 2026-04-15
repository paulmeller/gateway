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

console.log(`[hono] starting on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
