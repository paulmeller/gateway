import { Command } from "commander";
import { initBackend, getFormat } from "../index.js";
import { formatOutput, type Column } from "../output/table.js";
import { printJSON } from "../output/format.js";

const cols: Column[] = [
  { header: "SEQ", field: (e) => String(e.seq) },
  { header: "TYPE", field: (e) => e.type },
  { header: "CONTENT", field: (e) => {
    const content = e.content;
    if (Array.isArray(content)) {
      const text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      return text.length > 80 ? text.slice(0, 77) + "..." : text;
    }
    return "";
  }, width: 80 },
];

export function registerEventCommands(parent: Command): void {
  const events = parent.command("events").aliases(["event"]).description("Send and list session events");

  events.command("send <session-id>")
    .option("--message <text>", "Send a user message")
    .option("--interrupt", "Send an interrupt")
    .option("--json <data>", "Send raw event JSON")
    .action(async (sessionId, opts) => {
      const b = await initBackend();
      let evts: Array<Record<string, unknown>>;

      if (opts.message) {
        evts = [{ type: "user.message", content: [{ type: "text", text: opts.message }] }];
      } else if (opts.interrupt) {
        evts = [{ type: "user.interrupt" }];
      } else if (opts.json) {
        const parsed = JSON.parse(opts.json);
        evts = parsed.events ?? [parsed];
      } else {
        throw new Error("Specify --message, --interrupt, or --json");
      }

      const res = await b.events.send(sessionId, evts);
      const fmt = getFormat();
      if (fmt === "json") {
        printJSON(res);
      } else {
        for (const evt of res.events) {
          console.log(`Sent event: ${evt.type} (seq ${evt.seq})`);
        }
      }
    });

  events.command("list <session-id>")
    .option("--limit <n>", "Max events", "50")
    .option("--order <order>", "Sort: asc, desc", "asc")
    .option("--after-seq <n>", "After this sequence number")
    .action(async (sessionId, opts) => {
      const b = await initBackend();
      const res = await b.events.list(sessionId, {
        limit: Number(opts.limit), order: opts.order,
        after_seq: opts.afterSeq ? Number(opts.afterSeq) : undefined,
      });
      formatOutput(getFormat(), res.data, cols);
    });
}
