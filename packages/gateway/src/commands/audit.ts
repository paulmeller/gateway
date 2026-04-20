/**
 * `gateway audit` — tail the audit log from the local DB.
 *
 * Mirrors `GET /v1/audit-log` but reads directly via the SDK so it
 * works offline (no server needed). Admin-only operations are still
 * audited via the HTTP path, so this is intentionally a read-only
 * inspection tool — it doesn't have --add or --revoke flags.
 */
import { Command } from "commander";
import type { AuditOutcome } from "@agentstep/agent-sdk";

const VALID_OUTCOMES: AuditOutcome[] = ["success", "denied", "failure"];

export function registerAuditCommands(parent: Command): void {
  parent
    .command("audit")
    .description("Show recent audit-log entries (local DB).")
    .option("-n, --limit <n>", "Max rows (1..500). Default 50.", "50")
    .option("--action <verb>", "Exact match, e.g. tenants.create")
    .option("--actor <keyId>", "Filter by actor key id")
    .option("--tenant <id>", "Filter by tenant id")
    .option("--resource-type <type>", "agent | tenant | api_key | upstream_key | …")
    .option("--resource-id <id>", "Specific resource id")
    .option("--outcome <outcome>", "success | denied | failure")
    .option("--json", "Print entries as JSON lines")
    .action(async (opts: {
      limit: string;
      action?: string;
      actor?: string;
      tenant?: string;
      resourceType?: string;
      resourceId?: string;
      outcome?: string;
      json?: boolean;
    }) => {
      const { listAudit, ensureInitialized } = await import("@agentstep/agent-sdk");
      await ensureInitialized();

      let outcome: AuditOutcome | undefined;
      if (opts.outcome) {
        if (!VALID_OUTCOMES.includes(opts.outcome as AuditOutcome)) {
          console.error(`invalid --outcome: ${opts.outcome} (valid: ${VALID_OUTCOMES.join(", ")})`);
          process.exit(1);
        }
        outcome = opts.outcome as AuditOutcome;
      }

      const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);

      const rows = listAudit({
        limit,
        action: opts.action,
        actor_key_id: opts.actor,
        tenantFilter: opts.tenant ?? null,
        resource_type: opts.resourceType,
        resource_id: opts.resourceId,
        outcome,
      });

      if (opts.json) {
        for (const row of rows) console.log(JSON.stringify(row));
        return;
      }

      if (rows.length === 0) {
        console.log("No matching entries.");
        return;
      }

      // Human-readable: timestamp | actor | action | tenant | resource | outcome
      for (const row of rows) {
        const ts = row.created_at;
        const actor = row.actor_name ?? row.actor_key_id ?? "system";
        const tenant = row.tenant_id ?? "-";
        const resource = row.resource_type && row.resource_id
          ? `${row.resource_type}:${row.resource_id}`
          : "-";
        console.log(
          `${ts}  ${actor.padEnd(20)}  ${row.action.padEnd(28)}  ${tenant.padEnd(20)}  ${resource.padEnd(40)}  ${row.outcome}`,
        );
      }
    });
}
