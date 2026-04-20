/**
 * `gateway tenants` — tenancy administration CLI (v0.5).
 *
 * Commands:
 *   tenants list                  — list active tenants
 *   tenants create <name>         — create a new tenant
 *   tenants migrate-legacy        — interactive, one-shot, opt-in.
 *                                   Assigns all null-tenant rows to a
 *                                   target tenant (default or new).
 *   tenants archive <id>          — soft-delete a tenant (refuses default)
 *
 * This is intentionally a local-only CLI: it imports @agentstep/agent-sdk
 * directly and mutates the local DB. Remote-mode is not supported for
 * migrations (they need DB-level transactions the HTTP API doesn't
 * expose).
 */
import { Command } from "commander";
import * as p from "@clack/prompts";

export function registerTenantCommands(parent: Command): void {
  const tenants = parent
    .command("tenants")
    .description("Manage tenants (multi-tenancy administration, local DB only)");

  tenants
    .command("list")
    .description("List active tenants")
    .action(async () => {
      const { listTenants } = await import("@agentstep/agent-sdk");
      const { ensureInitialized } = await import("@agentstep/agent-sdk");
      await ensureInitialized();
      const rows = listTenants();
      if (rows.length === 0) {
        console.log("No tenants yet.");
        return;
      }
      for (const t of rows) {
        console.log(`${t.id}  ${t.name.padEnd(30)}  created ${t.created_at}`);
      }
    });

  tenants
    .command("create <name>")
    .description("Create a new tenant")
    .action(async (name: string) => {
      const { createTenant, ensureInitialized } = await import("@agentstep/agent-sdk");
      await ensureInitialized();
      const t = createTenant({ name });
      console.log(`Created tenant: ${t.id}  name="${t.name}"`);
    });

  tenants
    .command("archive <id>")
    .description("Archive a tenant (soft-delete). Refuses to archive the default tenant.")
    .action(async (id: string) => {
      const { archiveTenant, ensureInitialized } = await import("@agentstep/agent-sdk");
      await ensureInitialized();
      const ok = archiveTenant(id);
      if (ok) console.log(`Archived ${id}.`);
      else console.error(`Could not archive ${id} (not found, already archived, or default tenant).`);
      if (!ok) process.exit(1);
    });

  tenants
    .command("rename <id> <name>")
    .description("Rename a tenant. The id stays the same; name is display-only.")
    .action(async (id: string, name: string) => {
      const { renameTenant, ensureInitialized } = await import("@agentstep/agent-sdk");
      await ensureInitialized();
      const ok = renameTenant(id, name);
      if (ok) console.log(`Renamed ${id} → "${name}".`);
      else {
        console.error(`Could not rename ${id} (not found).`);
        process.exit(1);
      }
    });

  tenants
    .command("migrate-legacy")
    .description(
      "Interactive: assign all null-tenant rows (agents/envs/vaults/sessions) to a " +
      "target tenant. This is the explicit opt-in step after upgrading from v0.4.",
    )
    .option("-y, --yes", "Skip interactive prompt")
    .option("--tenant <id>", "Target tenant id (default: tenant_default)")
    .action(async (opts: { yes?: boolean; tenant?: string }) => {
      const {
        ensureInitialized,
        listTenants,
        countNullTenantRows,
        assignNullRowsToTenant,
        DEFAULT_TENANT_ID,
      } = await import("@agentstep/agent-sdk");
      await ensureInitialized();

      const counts = countNullTenantRows();
      const total = counts.agents + counts.environments + counts.vaults + counts.sessions + counts.proxy_resources;
      console.log("");
      console.log("Null-tenant rows (would be migrated):");
      console.log(`  agents:           ${counts.agents}`);
      console.log(`  environments:     ${counts.environments}`);
      console.log(`  vaults:           ${counts.vaults}`);
      console.log(`  sessions:         ${counts.sessions}`);
      console.log(`  proxy_resources:  ${counts.proxy_resources}`);
      console.log("");
      if (counts.api_keys > 0) {
        console.log(`Also found ${counts.api_keys} null-tenant api_keys.`);
        console.log("These are NOT migrated — api keys stay global-admin by default.");
        console.log("Re-assign them explicitly via PATCH /v1/api-keys/:id if desired.");
        console.log("");
      }

      if (total === 0) {
        console.log("Nothing to migrate.");
        return;
      }

      const targetId = opts.tenant ?? DEFAULT_TENANT_ID;
      const allTenants = listTenants();
      const target = allTenants.find((t) => t.id === targetId);
      if (!target) {
        console.error(`Target tenant ${targetId} not found. Create it first with \`gateway tenants create <name>\`.`);
        process.exit(1);
      }

      if (!opts.yes) {
        if (!process.stdin.isTTY) {
          console.error("Non-TTY context: pass --yes to confirm.");
          process.exit(1);
        }
        const go = await p.confirm({
          message: `Migrate ${total} row(s) to tenant "${target.name}" (${target.id})?`,
          initialValue: false,
        });
        if (p.isCancel(go) || !go) {
          console.log("Cancelled.");
          return;
        }
      }

      const result = assignNullRowsToTenant(targetId);
      console.log("");
      console.log(`Migrated to ${target.id}:`);
      console.log(`  agents:           ${result.agents}`);
      console.log(`  environments:     ${result.environments}`);
      console.log(`  vaults:           ${result.vaults}`);
      console.log(`  sessions:         ${result.sessions}`);
      console.log(`  proxy_resources:  ${result.proxy_resources}`);
    });
}
