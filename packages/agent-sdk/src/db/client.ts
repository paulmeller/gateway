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

  // ZDR boot-time orphan reaper (PR-Z2). Sessions left in
  // `status='purging'` from a previous process that crashed
  // mid-purge get re-driven now. Best-effort: failures log and
  // continue, never block boot. The reaper is wrapped in a
  // try/catch so a regression here can't prevent DB init.
  //
  // Skipped when SKIP_ZDR_REAPER=1 (tests that boot the DB
  // multiple times and don't want the reaper noise). Production
  // never sets this.
  if (process.env.SKIP_ZDR_REAPER !== "1") {
    try {
      // Dynamic import to avoid an init-time circular reference
      // through audit-log → client.ts.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { reapPurgingSessions } = require("./zero-retention") as {
        reapPurgingSessions(): { reaped: number; failed: number };
      };
      reapPurgingSessions();
    } catch (err) {
      console.warn("[zdr.reaper] boot reaper failed (ignoring):", err);
    }
  }

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
