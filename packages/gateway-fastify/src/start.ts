/**
 * Entry point for the Fastify adapter.
 *
 * Loads .env from the project root, then starts the HTTP server.
 */
import "dotenv/config";
import { buildApp } from "./index.js";

const port = Number(process.env.PORT ?? 4000);
const app = buildApp();

app.listen({ port, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[fastify] listening on http://localhost:${port}`);
});
