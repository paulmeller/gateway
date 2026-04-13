/**
 * Shared interactive chat loop used by both `gateway chat` and `gateway quickstart`.
 */
import { createInterface } from "node:readline";
import chalk from "chalk";
import ora from "ora";
import type { Backend } from "../backend/interface.js";
import { renderEvent } from "../output/render-event.js";

export async function runChatLoop(
  backend: Backend,
  sessionId: string,
  opts: { verbose: boolean; initialStatus?: string; startSeq?: number },
): Promise<void> {
  const verbose = opts.verbose;
  const startSeq = opts.startSeq ?? 0;

  // Fetch and render history if starting from 0
  let lastSeq = startSeq;
  if (startSeq === 0) {
    const history = await backend.events.list(sessionId, { limit: 200, order: "asc" });
    for (const evt of history.data) {
      renderEvent(evt, verbose);
      if (evt.seq > lastSeq) lastSeq = evt.seq;
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  let isRunning = opts.initialStatus === "running";
  let interruptSent = false;
  let pendingConfirmation: any = null;

  const spinner = ora({ text: "Agent is thinking...", spinner: "dots" });

  if (!isRunning) {
    rl.prompt();
  } else {
    spinner.start();
  }

  // Ctrl+C handling
  rl.on("SIGINT", async () => {
    if (isRunning && !interruptSent) {
      interruptSent = true;
      spinner.stop();
      console.log("\n[interrupted — press Ctrl+C again to exit]");
      try {
        await backend.events.send(sessionId, [{ type: "user.interrupt" }]);
      } catch {}
    } else {
      spinner.stop();
      console.log();
      process.exit(0);
    }
  });

  // User input
  rl.on("line", async (line) => {
    const trimmed = line.trim();

    // Handle pending tool confirmation
    if (pendingConfirmation) {
      const evt = pendingConfirmation;
      pendingConfirmation = null;
      const result = ["n", "no", "deny"].includes(trimmed.toLowerCase()) ? "deny" : "allow";
      try {
        await backend.events.send(sessionId, [{
          type: "user.tool_confirmation",
          tool_use_id: evt.tool_use_id ?? evt.id,
          result,
        }]);
      } catch (err: any) {
        console.error(chalk.red(`Error sending confirmation: ${err.message}`));
      }
      return;
    }

    if (!trimmed) {
      if (!isRunning) rl.prompt();
      return;
    }

    try {
      await backend.events.send(sessionId, [{
        type: "user.message",
        content: [{ type: "text", text: trimmed }],
      }]);
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      rl.prompt();
    }
  });

  rl.on("close", () => {
    spinner.stop();
    console.log();
    process.exit(0);
  });

  // Stream events
  try {
    for await (const evt of backend.events.stream(sessionId, lastSeq)) {
      const evtType = evt.type;

      if (["agent.message", "session.status_idle", "session.error", "session.status_terminated"].includes(evtType)) {
        spinner.stop();
      }

      const needsConfirm = renderEvent(evt, verbose);
      if (needsConfirm) {
        spinner.stop();
        pendingConfirmation = evt;
      }

      if (evtType === "session.status_running") {
        isRunning = true;
        interruptSent = false;
        spinner.start();
      } else if (evtType === "session.status_idle") {
        isRunning = false;
        interruptSent = false;
        spinner.stop();
        rl.prompt();
      } else if (evtType === "session.status_terminated") {
        spinner.stop();
        rl.close();
        return;
      }
    }
  } catch (err: any) {
    spinner.stop();
    console.error(chalk.red(`Stream error: ${err.message}`));
  }

  rl.close();
}
