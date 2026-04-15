import { Command } from "commander";
import { initBackend } from "../index.js";
import { runChatLoop } from "./chat-loop.js";

export function registerChatCommand(parent: Command): void {
  parent.command("chat <session-id>")
    .description("Interactive chat with a session")
    .action(async (sessionId) => {
      const b = await initBackend();
      const verbose = parent.opts().verbose ?? false;

      const session = await b.sessions.get(sessionId);
      console.log(`Session ${session.id} (status: ${session.status})`);
      console.log("Type a message and press Enter. Ctrl+C to interrupt, Ctrl+D to exit.");
      console.log("─".repeat(60));

      await runChatLoop(b, sessionId, { verbose, initialStatus: session.status });
    });
}
