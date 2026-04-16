import { Command } from "commander";
import { initBackend, getFormat } from "../index.js";
import { formatOutput, type Column } from "../output/table.js";

const storeCols: Column[] = [
  { header: "ID", field: (s) => s.id },
  { header: "NAME", field: (s) => s.name },
  { header: "CREATED", field: (s) => s.created_at },
];

const memCols: Column[] = [
  { header: "ID", field: (m) => m.id },
  { header: "PATH", field: (m) => m.path },
  { header: "UPDATED", field: (m) => m.updated_at },
];

export function registerMemoryCommands(parent: Command): void {
  const mem = parent.command("memory-stores").aliases(["mem"]).description("Manage memory stores");

  mem.command("create")
    .requiredOption("--name <name>", "Store name")
    .option("--description <desc>", "Description")
    .action(async (opts) => {
      const b = await initBackend();
      const store = await b.memory.stores.create({ name: opts.name, description: opts.description });
      formatOutput(getFormat(), store, storeCols);
    });

  mem.command("list").action(async () => {
    const b = await initBackend();
    const res = await b.memory.stores.list();
    formatOutput(getFormat(), res.data, storeCols);
  });

  mem.command("get <id>").action(async (id) => {
    const b = await initBackend();
    formatOutput(getFormat(), await b.memory.stores.get(id), storeCols);
  });

  mem.command("delete <id>").action(async (id) => {
    const b = await initBackend();
    const res = await b.memory.stores.delete(id);
    console.log(`Deleted memory store ${res.id}`);
  });

  const memories = mem.command("memories").aliases(["memory"]).description("Manage memories");

  memories.command("create <store-id>")
    .requiredOption("--path <path>", "Memory path")
    .requiredOption("--content <content>", "Memory content")
    .action(async (storeId, opts) => {
      const b = await initBackend();
      const m = await b.memory.memories.create(storeId, { path: opts.path, content: opts.content });
      formatOutput(getFormat(), m, memCols);
    });

  memories.command("list <store-id>").action(async (storeId) => {
    const b = await initBackend();
    const res = await b.memory.memories.list(storeId);
    formatOutput(getFormat(), res.data, memCols);
  });

  memories.command("get <store-id> <memory-id>").action(async (storeId, memId) => {
    const b = await initBackend();
    const m = await b.memory.memories.get(storeId, memId);
    formatOutput(getFormat(), m, [...memCols, { header: "CONTENT", field: (m: any) => m.content }]);
  });

  memories.command("update <store-id> <memory-id>")
    .requiredOption("--content <content>", "New content")
    .option("--content-sha256 <hash>", "Expected SHA256")
    .action(async (storeId, memId, opts) => {
      const b = await initBackend();
      const m = await b.memory.memories.update(storeId, memId, { content: opts.content, content_sha256: opts.contentSha256 });
      formatOutput(getFormat(), m, memCols);
    });

  memories.command("delete <store-id> <memory-id>").action(async (storeId, memId) => {
    const b = await initBackend();
    const res = await b.memory.memories.delete(storeId, memId);
    console.log(`Deleted memory ${res.id}`);
  });
}
