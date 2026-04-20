/**
 * Tenants — v0.5 multi-tenant isolation primitive.
 *
 * A tenant groups a set of API keys + agents + environments + vaults +
 * sessions into an isolated namespace. Global admins (tenantId=null on
 * the key) see across all tenants; tenant admins/users are scoped to
 * theirs.
 *
 * Seeding: the `default` tenant row is inserted on first boot by init.ts
 * via INSERT OR IGNORE. Existing (pre-0.5) resources stay tenant_id=null
 * — the operator runs `gateway tenants migrate-legacy` to assign them
 * explicitly. Nothing auto-migrates.
 */
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type { Tenant, TenantRow } from "../types";

export const DEFAULT_TENANT_ID = "tenant_default";

function hydrate(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    created_at: toIso(row.created_at),
    archived_at: row.archived_at ? toIso(row.archived_at) : null,
  };
}

/**
 * Seed the `default` tenant on first boot. Idempotent via INSERT OR IGNORE —
 * safe to call repeatedly. Called from init.ts.
 */
export function seedDefaultTenant(): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(DEFAULT_TENANT_ID, "default", nowMs());
}

export function createTenant(input: { id?: string; name: string }): Tenant {
  const db = getDb();
  // Allow callers to pass an explicit id (used by the migration CLI to
  // seed deterministic tenant ids) but default to a random ulid.
  const id = input.id ?? newId("tenant");
  const now = nowMs();
  db.prepare(
    `INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, input.name, now);
  return { id, name: input.name, created_at: toIso(now), archived_at: null };
}

export function getTenant(id: string): Tenant | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM tenants WHERE id = ?`)
    .get(id) as TenantRow | undefined;
  return row ? hydrate(row) : null;
}

export function listTenants(opts: { includeArchived?: boolean } = {}): Tenant[] {
  const db = getDb();
  const rows = opts.includeArchived
    ? (db.prepare(`SELECT * FROM tenants ORDER BY created_at ASC`).all() as TenantRow[])
    : (db
        .prepare(`SELECT * FROM tenants WHERE archived_at IS NULL ORDER BY created_at ASC`)
        .all() as TenantRow[]);
  return rows.map(hydrate);
}

export function archiveTenant(id: string): boolean {
  // Don't allow archiving the default tenant — it's the fallback for
  // unmigrated rows and new keys created by global admins who don't
  // specify a tenant.
  if (id === DEFAULT_TENANT_ID) return false;
  const db = getDb();
  const res = db
    .prepare(`UPDATE tenants SET archived_at = ? WHERE id = ? AND archived_at IS NULL`)
    .run(nowMs(), id);
  return res.changes > 0;
}

export function renameTenant(id: string, name: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`UPDATE tenants SET name = ? WHERE id = ?`)
    .run(name, id);
  return res.changes > 0;
}

/**
 * Assign every null-tenant row to `tenantId` across the tenancy-scoped
 * tables. Returns per-table counts. Used by `gateway tenants migrate-legacy`.
 *
 * Runs in a single transaction so an abort leaves nothing half-migrated.
 * Does NOT touch api_keys — that's a separate step (the operator may
 * want different keys in different tenants).
 *
 * v0.5+: also covers `proxy_resources` so that v0.4 Anthropic-backend
 * sessions/agents/envs survive the upgrade (the new tenant guard would
 * otherwise 404 them for anyone who isn't a global admin).
 */
export function assignNullRowsToTenant(
  tenantId: string,
): Record<"agents" | "environments" | "vaults" | "sessions" | "proxy_resources", number> {
  const db = getDb();
  const counts = { agents: 0, environments: 0, vaults: 0, sessions: 0, proxy_resources: 0 };
  const tx = db.transaction(() => {
    for (const table of ["agents", "environments", "vaults", "sessions", "proxy_resources"] as const) {
      const res = db
        .prepare(`UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL`)
        .run(tenantId);
      counts[table] = res.changes;
    }
  });
  tx();
  return counts;
}

/** Counts of null-tenant rows across the tenancy-scoped tables. */
export function countNullTenantRows(): Record<
  "agents" | "environments" | "vaults" | "sessions" | "api_keys" | "proxy_resources",
  number
> {
  const db = getDb();
  const c = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    agents:          c(`SELECT COUNT(*) AS n FROM agents           WHERE tenant_id IS NULL AND archived_at IS NULL`),
    environments:    c(`SELECT COUNT(*) AS n FROM environments     WHERE tenant_id IS NULL AND archived_at IS NULL`),
    vaults:          c(`SELECT COUNT(*) AS n FROM vaults           WHERE tenant_id IS NULL`),
    sessions:        c(`SELECT COUNT(*) AS n FROM sessions         WHERE tenant_id IS NULL`),
    api_keys:        c(`SELECT COUNT(*) AS n FROM api_keys         WHERE tenant_id IS NULL AND revoked_at IS NULL`),
    proxy_resources: c(`SELECT COUNT(*) AS n FROM proxy_resources  WHERE tenant_id IS NULL`),
  };
}
