import { Command } from "commander";
import { initBackend, getFormat } from "../index.js";
import { formatOutput, type Column } from "../output/table.js";

const cols: Column[] = [
  { header: "ID", field: (v) => v.id },
  { header: "NAME", field: (v) => v.name },
  { header: "AGENT", field: (v) => v.agent_id },
  { header: "CREATED", field: (v) => v.created_at },
];

const entryCols: Column[] = [
  { header: "KEY", field: (e) => e.key },
  { header: "VALUE", field: (e) => { const v = e.value ?? ""; return v.length > 60 ? v.slice(0, 57) + "..." : v; }, width: 60 },
];

export function registerVaultCommands(parent: Command): void {
  const vaults = parent.command("vaults").aliases(["vault"]).description("Manage vaults and entries");

  vaults.command("create")
    .requiredOption("--agent <id>", "Agent ID")
    .requiredOption("--name <name>", "Vault name")
    .action(async (opts) => {
      const b = await initBackend();
      const vault = await b.vaults.create({ agent_id: opts.agent, name: opts.name });
      formatOutput(getFormat(), vault, cols);
    });

  vaults.command("list")
    .option("--agent-id <id>", "Filter by agent")
    .action(async (opts) => {
      const b = await initBackend();
      const res = await b.vaults.list({ agent_id: opts.agentId });
      formatOutput(getFormat(), res.data, cols);
    });

  vaults.command("get <id>").action(async (id) => {
    const b = await initBackend();
    formatOutput(getFormat(), await b.vaults.get(id), cols);
  });

  vaults.command("delete <id>").action(async (id) => {
    const b = await initBackend();
    const res = await b.vaults.delete(id);
    console.log(`Deleted vault ${res.id}`);
  });

  const entries = vaults.command("entries").aliases(["entry"]).description("Manage vault entries");

  entries.command("list <vault-id>").action(async (vaultId) => {
    const b = await initBackend();
    const res = await b.vaults.entries.list(vaultId);
    formatOutput(getFormat(), res.data, entryCols);
  });

  entries.command("get <vault-id> <key>").action(async (vaultId, key) => {
    const b = await initBackend();
    const entry = await b.vaults.entries.get(vaultId, key);
    const fmt = getFormat();
    if (fmt === "json") console.log(JSON.stringify(entry, null, 2));
    else console.log(entry.value);
  });

  entries.command("set <vault-id> <key> <value>").action(async (vaultId, key, value) => {
    const b = await initBackend();
    const entry = await b.vaults.entries.set(vaultId, key, value);
    console.log(`Set ${entry.key} = ${entry.value}`);
  });

  entries.command("delete <vault-id> <key>").action(async (vaultId, key) => {
    const b = await initBackend();
    await b.vaults.entries.delete(vaultId, key);
    console.log(`Deleted entry ${key}`);
  });
}
