/**
 * `gateway db` — database administration.
 *
 * Currently: `db reset` (destructive local wipe). Shape left open for
 * future `db path`, `db info`, `db backup` subcommands.
 *
 * Reset is intentionally **local-only and destructive**. The decision logic
 * (planReset) is separated from IO (performReset + doReset) so the safety
 * checks are unit-testable without mocking process.exit / console / prompts.
 */
import { Command } from "commander";
import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, effectiveBaseUrl } from "../config/file.js";

// ─── Pure helpers (exported for tests) ────────────────────────────────────

/** Resolve the local SQLite path the same way agent-sdk does. */
export function resolveDbPath(cwd: string = process.cwd(), envPath?: string | null): string {
  const p = envPath ?? process.env.DATABASE_PATH ?? "./data/managed-agents.db";
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

/** True if the URL's host is a loopback address. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // URL.hostname wraps IPv6 in brackets — strip them before comparison.
    const h = u.hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
  } catch {
    return false;
  }
}

/** Size of a file on disk, or 0 if missing. */
export function fileSize(pathStr: string): number {
  try {
    return fs.statSync(pathStr).size;
  } catch {
    return 0;
  }
}

/** Recursive directory size, or 0 if missing. */
export function dirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fileSize(full);
  }
  return total;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ─── Plan (pure decision) ─────────────────────────────────────────────────

export interface ResetOpts {
  yes?: boolean;
  includeFiles?: boolean;
  dryRun?: boolean;
}

export interface ResetPlanInput {
  opts: ResetOpts;
  remoteFlag?: string;
  baseUrl: string;
  baseUrlFromConfig: boolean;
  tursoUrl?: string | null;
  /** Urls to probe for a live server. */
  probeUrls: string[];
  /** Resolved paths. Caller supplies to avoid re-resolving during tests. */
  dbPath: string;
}

export type ResetPlan =
  | { kind: "refuse"; reason: string }
  | { kind: "noop"; reason: string }
  | {
      kind: "proceed";
      targets: {
        dbPath: string;
        walPath: string;
        shmPath: string;
        filesDir: string;
        /** Files that actually exist and will be removed. */
        present: string[];
        /** True if --include-files AND filesDir is non-empty. */
        wipeFiles: boolean;
        /** Total bytes to be freed (for display only). */
        bytes: number;
      };
    };

/**
 * Pure planning step: inspect env, config, probes, and disk. Returns what
 * to do. No side effects other than the probe function the caller passed.
 */
export async function planReset(
  input: ResetPlanInput,
  probe: (url: string) => Promise<boolean>,
): Promise<ResetPlan> {
  // 1. Turso embedded replica — wipe would re-sync from remote on next boot.
  if (input.tursoUrl) {
    return {
      kind: "refuse",
      reason:
        "TURSO_URL is set. The embedded replica would re-sync from remote on next boot, undoing the wipe. Unset TURSO_URL or reset the remote database directly.",
    };
  }

  // 2. --remote or a non-loopback base-url → user is pointed at a remote
  // server; this command only touches local files.
  if (input.remoteFlag) {
    return {
      kind: "refuse",
      reason: "--remote is set. `db reset` only touches the local SQLite files.",
    };
  }
  if (input.baseUrlFromConfig && !isLoopbackUrl(input.baseUrl)) {
    return {
      kind: "refuse",
      reason: `base-url points to a non-loopback host (${input.baseUrl}).`,
    };
  }

  // 3. Probe for a live server on any plausible port. A running serve
  // process holds an open inode and will resurrect the wiped DB.
  for (const url of input.probeUrls) {
    if (await probe(url)) {
      return {
        kind: "refuse",
        reason: `a gateway server is responding on ${url}. Stop it first (Ctrl-C the \`gateway serve\` or \`npm run dev\` process), then retry.`,
      };
    }
  }

  // 4. Enumerate targets.
  const dbPath = input.dbPath;
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const filesDir = path.join(path.dirname(dbPath), "files");

  const present: string[] = [];
  let bytes = 0;
  for (const p of [dbPath, walPath, shmPath]) {
    const sz = fileSize(p);
    if (sz > 0) {
      present.push(p);
      bytes += sz;
    }
  }
  const filesBytes = input.opts.includeFiles ? dirSize(filesDir) : 0;
  const wipeFiles = Boolean(input.opts.includeFiles) && filesBytes > 0;
  if (wipeFiles) bytes += filesBytes;

  if (present.length === 0 && !wipeFiles) {
    return { kind: "noop", reason: `${dbPath} does not exist.` };
  }

  return {
    kind: "proceed",
    targets: { dbPath, walPath, shmPath, filesDir, present, wipeFiles, bytes },
  };
}

// ─── Perform (isolated IO) ────────────────────────────────────────────────

export interface PerformResult {
  removed: number;
  wipedFiles: boolean;
  /** Error code, e.g. "EBUSY" if any target was locked. Thrown if not caught. */
}

/**
 * Execute the plan. Returns summary stats. Assumes the caller has already
 * confirmed and closed any same-process DB handle.
 *
 * Throws on EBUSY with a hint (caller decides whether to exit or rethrow).
 */
export function performReset(
  targets: (ResetPlan & { kind: "proceed" })["targets"],
): PerformResult {
  // Unlink order: -wal, -shm, then main DB. If the main file goes first
  // and -wal unlink fails, next SQLite boot sees a WAL without a DB and
  // gets confused.
  let removed = 0;
  for (const target of [targets.walPath, targets.shmPath, targets.dbPath]) {
    try {
      fs.unlinkSync(target);
      removed++;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw err; // EBUSY etc — caller reports.
    }
  }

  let wipedFiles = false;
  if (targets.wipeFiles && fs.existsSync(targets.filesDir)) {
    fs.rmSync(targets.filesDir, { recursive: true, force: true });
    fs.mkdirSync(targets.filesDir, { recursive: true });
    wipedFiles = true;
  }

  return { removed, wipedFiles };
}

// ─── Network probe ────────────────────────────────────────────────────────

/**
 * Best-effort probe: does a gateway server respond on this URL?
 *
 * Hits /api/health — the Hono + Fastify servers both expose that. We also
 * accept `/api/health` returning 401 (the endpoint is public, but anyone
 * could mount auth middleware in front of it). The point is to detect
 * "something is listening on this port that looks like us," not to perform
 * an authenticated check.
 */
export async function probeServerAlive(baseUrl: string, timeoutMs = 500): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 2xx OR 401 (auth middleware in front). Any other non-network response
    // also counts — *something* is responding on the port.
    return res.status < 500;
  } catch {
    return false;
  }
}

// ─── CLI action (orchestrates IO) ─────────────────────────────────────────

async function doReset(opts: ResetOpts, globalOpts: { remote?: string }): Promise<void> {
  const cfg = loadConfig();
  const baseUrl = effectiveBaseUrl(cfg);
  const dbPath = resolveDbPath();

  // Probe both the configured base-url and the `gateway serve` default
  // (:4000) — the CLI's base-url defaults to :3000 (Next.js dev), but the
  // Hono server started by `gateway serve` listens on :4000.
  //
  // Known limitation: `gateway serve --port N` on a non-default port won't
  // be detected. If you run into an EBUSY on a platform that locks the DB
  // (Windows), stop the serve process and retry. On macOS the unlink will
  // succeed against an open fd; the running server will keep writing to
  // the unlinked inode until restart — if you hit this, run `db reset`
  // again after stopping serve.
  const probeUrls = Array.from(new Set([baseUrl, "http://localhost:4000"]));

  const plan = await planReset(
    {
      opts,
      remoteFlag: globalOpts.remote,
      baseUrl,
      // An explicit base-url — from either config or env — gates the
      // non-loopback refusal. GATEWAY_BASE_URL=https://prod would otherwise
      // slip past since it isn't in cfg.
      baseUrlFromConfig: Boolean(cfg["base-url"]) || Boolean(process.env.GATEWAY_BASE_URL),
      tursoUrl: process.env.TURSO_URL,
      probeUrls,
      dbPath,
    },
    probeServerAlive,
  );

  if (plan.kind === "refuse") {
    console.error(`Refusing to reset: ${plan.reason}`);
    process.exit(1);
  }
  if (plan.kind === "noop") {
    console.log(`Nothing to reset — ${plan.reason}`);
    return;
  }

  const { targets } = plan;

  // Show scope.
  console.log("Will delete:");
  for (const p of targets.present) {
    console.log(`  ${p} (${fmtBytes(fileSize(p))})`);
  }
  if (targets.wipeFiles) {
    console.log(`  ${targets.filesDir}/ (${fmtBytes(dirSize(targets.filesDir))})`);
  }
  console.log("Will preserve:");
  console.log("  .env (SEED_API_KEY, VAULT_ENCRYPTION_KEY — re-seeded on next boot)");
  if (!targets.wipeFiles) console.log(`  ${targets.filesDir}/ (pass --include-files to wipe)`);

  if (opts.dryRun) {
    console.log("\n(dry run — nothing deleted)");
    return;
  }

  // Confirmation. Non-TTY requires explicit --yes — never silently proceed
  // in a CI pipeline.
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.error("\nRefusing to proceed in non-TTY context without --yes.");
      process.exit(1);
    }
    const ok = await p.confirm({
      message: "Proceed with reset?",
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) {
      console.log("Cancelled.");
      return;
    }
  }

  // Close any in-process DB handle so we don't unlink a file we still
  // hold open. Dynamic import — we don't want `db reset` to trigger the
  // CLI's usual backend init, which would recreate the DB before we wipe
  // it.
  try {
    const { closeDb } = await import("@agentstep/agent-sdk");
    closeDb();
  } catch {
    // closeDb isn't exported or never opened — fine, nothing to close.
  }

  try {
    const { removed, wipedFiles } = performReset(targets);
    console.log(`\n→ fresh (removed ${removed} DB file${removed === 1 ? "" : "s"}${wipedFiles ? " + files dir" : ""})`);
    console.log("  Next `gateway serve` will re-seed the API key from .env and re-run migrations.");
    console.log(
      "\nNote: any sandboxed containers created by the old sessions may still be running.\n" +
        "  docker ps / podman ps / container ls    — to inspect and reap manually",
    );
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY") {
      console.error(
        `\nCould not delete DB files: locked. Is another \`gateway\` process (serve/chat/stream) running? Stop it and retry.`,
      );
      process.exit(1);
    }
    throw err;
  }
}

// ─── Register ─────────────────────────────────────────────────────────────

export function registerDbCommands(parent: Command): void {
  const db = parent.command("db").description("Database administration (local only)");

  db.command("reset")
    .description("Wipe the local SQLite database (destructive)")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--include-files", "Also wipe data/files/ (uploaded session files)")
    .option("--dry-run", "Show what would be deleted without deleting")
    .action(async (opts: ResetOpts) => {
      await doReset(opts, parent.opts() as { remote?: string });
    });
}
