/**
 * `gateway upstream-keys` — pool management from the terminal.
 *
 * Local-DB only (same pattern as `tenants`). Remote-mode management
 * should go through the `/v1/upstream-keys` REST surface; this CLI is
 * convenient for single-host operators and migrations.
 */
import { Command } from "commander";
import * as p from "@clack/prompts";

type UpstreamProvider = "anthropic" | "openai" | "gemini";
const VALID: UpstreamProvider[] = ["anthropic", "openai", "gemini"];

function mask(prefix: string): string {
  return `${prefix}…`;
}

export function registerUpstreamKeyCommands(parent: Command): void {
  const pool = parent
    .command("upstream-keys")
    .description("Manage the upstream provider-key pool (anthropic/openai/gemini).");

  pool
    .command("list")
    .description("List pool entries.")
    .option("--provider <name>", "Filter by provider")
    .action(async (opts: { provider?: string }) => {
      const sdk = await import("@agentstep/agent-sdk");
      await sdk.ensureInitialized();
      const { listUpstreamKeys } = await import("@agentstep/agent-sdk/db/upstream_keys");
      const rows = listUpstreamKeys(opts.provider);
      if (rows.length === 0) {
        console.log("No pooled keys.");
        return;
      }
      for (const r of rows) {
        const state = r.disabled_at ? "disabled" : "active";
        const lastUsed = r.last_used_at ? new Date(r.last_used_at).toISOString() : "never";
        console.log(
          `${r.id.padEnd(24)}  ${r.provider.padEnd(10)}  ${mask(r.prefix).padEnd(14)}  ${state.padEnd(10)}  last_used=${lastUsed}`,
        );
      }
    });

  pool
    .command("add")
    .description("Add a key to the pool. Prompts for the value interactively.")
    .requiredOption("--provider <name>", "anthropic | openai | gemini")
    .option("--value <value>", "Key value (prefer the interactive prompt — avoids shell history)")
    .option("--weight <n>", "Integer selection weight", "1")
    .action(async (opts: { provider: string; value?: string; weight: string }) => {
      if (!VALID.includes(opts.provider as UpstreamProvider)) {
        console.error(`invalid --provider: ${opts.provider} (valid: ${VALID.join(", ")})`);
        process.exit(1);
      }
      let value = opts.value;
      if (value) {
        // --value ends up in the user's shell history. Flag it once so
        // ops can either clean their history or switch to the prompt.
        console.warn(
          "warning: the key value is visible in your shell history. " +
          "Prefer piping through the interactive prompt: `gateway upstream-keys add --provider <p>`.",
        );
      }
      if (!value) {
        if (!process.stdin.isTTY) {
          console.error("Non-TTY: pass --value.");
          process.exit(1);
        }
        const res = await p.password({
          message: `Paste the ${opts.provider} API key (input hidden)`,
          validate: (v) => ((v?.trim().length ?? 0) < 20 ? "Too short — is this really a key?" : undefined),
        });
        if (p.isCancel(res)) {
          console.log("Cancelled.");
          return;
        }
        value = res;
      }
      const weight = Math.max(1, Math.floor(Number(opts.weight) || 1));
      const sdk = await import("@agentstep/agent-sdk");
      await sdk.ensureInitialized();
      const { addUpstreamKey } = await import("@agentstep/agent-sdk/db/upstream_keys");
      try {
        const added = addUpstreamKey({
          provider: opts.provider,
          value: value.trim(),
          weight,
        });
        console.log(`Added ${added.id} (${added.provider}, prefix=${added.prefix})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/UNIQUE/i.test(msg)) {
          console.error("An identical value is already in the pool for this provider.");
        } else {
          console.error(msg);
        }
        process.exit(1);
      }
    });

  pool
    .command("disable <id>")
    .description("Disable a pool entry (stops it being selected).")
    .action(async (id: string) => {
      const sdk = await import("@agentstep/agent-sdk");
      await sdk.ensureInitialized();
      const { disableUpstreamKey } = await import("@agentstep/agent-sdk/db/upstream_keys");
      const ok = disableUpstreamKey(id);
      if (ok) console.log(`Disabled ${id}.`);
      else {
        console.error(`Could not disable ${id} (not found or already disabled).`);
        process.exit(1);
      }
    });

  pool
    .command("enable <id>")
    .description("Re-enable a previously disabled pool entry.")
    .action(async (id: string) => {
      const sdk = await import("@agentstep/agent-sdk");
      await sdk.ensureInitialized();
      const { enableUpstreamKey } = await import("@agentstep/agent-sdk/db/upstream_keys");
      const ok = enableUpstreamKey(id);
      if (ok) console.log(`Enabled ${id}.`);
      else {
        console.error(`Could not enable ${id} (not found).`);
        process.exit(1);
      }
    });

  pool
    .command("delete <id>")
    .description("Permanently remove a pool entry.")
    .action(async (id: string) => {
      const sdk = await import("@agentstep/agent-sdk");
      await sdk.ensureInitialized();
      const { deleteUpstreamKey } = await import("@agentstep/agent-sdk/db/upstream_keys");
      const ok = deleteUpstreamKey(id);
      if (ok) console.log(`Deleted ${id}.`);
      else {
        console.error(`Could not delete ${id} (not found).`);
        process.exit(1);
      }
    });
}
