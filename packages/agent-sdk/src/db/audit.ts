/**
 * Audit log storage — append-only ledger of admin-sensitive operations.
 *
 * Writes are best-effort and never block the request: `recordAudit()`
 * swallows all DB errors and logs a warning. The gateway is still
 * functional without the log, and a disk-full / sqlite-locked moment
 * shouldn't take down tenant management with it.
 *
 * Reads are tenant-scoped by default (see handlers/audit.ts): tenant
 * admins see entries for their own tenant, global admins see all.
 */
import { getDb } from "./client";
import { newId } from "../util/ids";
import { nowMs, toIso } from "../util/clock";
import type {
  AuditLogEntry, AuditLogRow, AuditOutcome, AuthContext,
} from "../types";
import { hasFeature, COMMUNITY_LIMITS } from "../license";

function hydrate(row: AuditLogRow): AuditLogEntry {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    created_at: toIso(row.created_at),
    actor_key_id: row.actor_key_id,
    actor_name: row.actor_name,
    tenant_id: row.tenant_id,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    outcome: row.outcome,
    metadata: metadata,
  };
}

export interface AuditInput {
  /** The caller. When null (system-initiated), actor fields are stored as null. */
  auth: AuthContext | null;
  /** Dotted verb, e.g. "tenants.create", "api_keys.revoke", "upstream_keys.add". */
  action: string;
  resource_type?: string;
  resource_id?: string;
  /** "success" unless specified. */
  outcome?: AuditOutcome;
  /** Tenant scope. Defaults to the caller's tenant id when auth is present. */
  tenant_id?: string | null;
  /** Arbitrary action-specific context. Small objects only — avoid PII. */
  metadata?: Record<string, unknown>;
}

/**
 * Write a single audit entry. Never throws — swallows DB errors with a
 * warning so the calling handler's primary success path is unaffected.
 */
export function recordAudit(input: AuditInput): void {
  try {
    const db = getDb();
    const id = newId("audit");
    db.prepare(
      `INSERT INTO audit_log (
         id, created_at, actor_key_id, actor_name, tenant_id,
         action, resource_type, resource_id, outcome, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      nowMs(),
      input.auth?.keyId ?? null,
      input.auth?.name ?? null,
      input.tenant_id !== undefined ? input.tenant_id : (input.auth?.tenantId ?? null),
      input.action,
      input.resource_type ?? null,
      input.resource_id ?? null,
      input.outcome ?? "success",
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
  } catch (err) {
    console.warn("[audit] failed to record entry:", err);
  }
}

export interface ListAuditOpts {
  /** Tenant filter. `null` = no filter (global admin only). */
  tenantFilter?: string | null;
  /** Limit. Clamped to 1..500. Default 100. */
  limit?: number;
  /** Cursor pagination. Pass the last row's `id` from the previous page. */
  cursor?: string;
  /** Optional filters — all ANDed. */
  action?: string;
  actor_key_id?: string;
  outcome?: AuditOutcome;
  resource_type?: string;
  resource_id?: string;
  createdGte?: number;
  createdLte?: number;
}

export function listAudit(opts: ListAuditOpts): AuditLogEntry[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.tenantFilter != null) {
    clauses.push("tenant_id = ?");
    params.push(opts.tenantFilter);
  }
  if (opts.action) {
    clauses.push("action = ?");
    params.push(opts.action);
  }
  if (opts.actor_key_id) {
    clauses.push("actor_key_id = ?");
    params.push(opts.actor_key_id);
  }
  if (opts.outcome) {
    clauses.push("outcome = ?");
    params.push(opts.outcome);
  }
  if (opts.resource_type) {
    clauses.push("resource_type = ?");
    params.push(opts.resource_type);
  }
  if (opts.resource_id) {
    clauses.push("resource_id = ?");
    params.push(opts.resource_id);
  }
  if (opts.createdGte != null) {
    clauses.push("created_at >= ?");
    params.push(opts.createdGte);
  }
  if (opts.createdLte != null) {
    clauses.push("created_at <= ?");
    params.push(opts.createdLte);
  }
  // Community tier: 7-day retention on reads. Enterprise: unlimited.
  // The data still accumulates (append-only); only the read window is
  // capped. Upgrade → instant access to the full history.
  if (!hasFeature("unlimited_audit") && opts.createdGte == null) {
    const cutoff = nowMs() - COMMUNITY_LIMITS.auditRetentionMs;
    clauses.push("created_at >= ?");
    params.push(cutoff);
  }

  if (opts.cursor) {
    // ULIDs sort by time within a single process, but two processes
    // writing in the same millisecond can produce out-of-order ids.
    // Use a composite (created_at, id) cursor so rows never get
    // double-returned or skipped across a page boundary — look up the
    // cursor row's timestamp and filter on (created_at, id) lexical
    // order.
    const anchor = db
      .prepare(`SELECT created_at FROM audit_log WHERE id = ?`)
      .get(opts.cursor) as { created_at: number } | undefined;
    if (anchor) {
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(anchor.created_at, anchor.created_at, opts.cursor);
    } else {
      // Unknown cursor — fall back to id-only so callers still make
      // forward progress rather than hitting an empty page.
      clauses.push("id < ?");
      params.push(opts.cursor);
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as AuditLogRow[];
  return rows.map(hydrate);
}
