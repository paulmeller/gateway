/**
 * libsql client with WAL + synchronous=NORMAL.
 *
 * Supports two modes:
 *   1. Local-only (default): DATABASE_PATH=./data/managed-agents.db
 *   2. Turso embedded replica: TURSO_URL + TURSO_AUTH_TOKEN env vars
 *      → local file syncs to/from a remote Turso database
 *
 * HMR-safe singleton: stores the Database instance on globalThis so Next.js
 * dev server reloads don't create a new handle per route compile.
 */
import Database from "libsql";
import path from "node:path";
import fs from "node:fs";
import { runMigrations } from "./migrations";

type DB = InstanceType<typeof Database>;

type GlobalDB = typeof globalThis & {
  __caDb?: DB;
  __caDbPath?: string;
};
const g = globalThis as GlobalDB;

function resolveDbPath(): string {
  const p = process.env.DATABASE_PATH || "./data/managed-agents.db";
  // turbopackIgnore: runtime-only path resolution — do not trace at build time
  return path.isAbsolute(p) ? p : path.join(/* turbopackIgnore: true */ process.cwd(), p);
}

export function getDb(): DB {
  if (g.__caDb) return g.__caDb;

  const dbPath = resolveDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tursoUrl = process.env.TURSO_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  const db = tursoUrl
    ? new Database(dbPath, { syncUrl: tursoUrl, authToken: tursoToken } as Record<string, unknown>)
    : new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  runMigrations(db);

  // Initial sync for embedded replicas
  if (tursoUrl) {
    try {
      (db as unknown as { sync(): void }).sync();
    } catch {
      // sync may fail on first boot if remote is empty — that's fine
    }
  }

  g.__caDb = db;
  g.__caDbPath = dbPath;
  return db;
}

/** Sync embedded replica with remote Turso. No-op if not using Turso. */
export function syncDb(): void {
  if (!g.__caDb || !process.env.TURSO_URL) return;
  try {
    (g.__caDb as unknown as { sync(): void }).sync();
  } catch (err) {
    console.warn("[db] sync failed:", err);
  }
}

export function closeDb(): void {
  if (g.__caDb) {
    g.__caDb.close();
    g.__caDb = undefined;
  }
}
