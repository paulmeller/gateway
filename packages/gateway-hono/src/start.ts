/**
 * Entry point for the Hono adapter.
 *
 * Loads .env from the project root (two levels up from packages/gateway-hono/),
 * then starts the HTTP server on the configured port.
 */
import "dotenv/config";
import { serve } from "@hono/node-server";
import app from "./index";

const port = Number(process.env.PORT ?? 4000);

console.log(`[hono] starting on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
