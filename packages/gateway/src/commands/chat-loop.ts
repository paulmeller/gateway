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

  // Show session info header
  try {
    const session = await backend.sessions.get(sessionId);
    const agentList = await backend.agents.list({ limit: 50 });
    const agentId = typeof session.agent === "string" ? session.agent : session.agent?.id;
    const agentObj = agentList.data.find((a: any) => a.id === agentId);

    let agentLine = "";
    if (agentObj) {
      const backendName = agentObj.backend ?? agentObj.engine ?? "";
      const model = agentObj.model ?? "";
      const agentDisplay = backendName && model ? `${agentObj.name} (${backendName} / ${model})` : agentObj.name;
      agentLine = `Agent: ${agentDisplay}`;
    }

    let envLine = "";
    const envId = session.environment_id ?? session.environment?.id;
    if (envId) {
      try {
        const envObj = await backend.environments.get(envId);
        const provider = envObj.config?.provider ?? envObj.provider ?? "";
        envLine = provider ? `Environment: ${envObj.name} (${provider})` : `Environment: ${envObj.name}`;
      } catch {
        envLine = `Environment: ${envId}`;
      }
    }

    const sessionLine = `Session: ${sessionId}`;

    if (agentLine) console.log(agentLine);
    if (envLine) console.log(envLine);
    console.log(sessionLine);
    console.log("─".repeat(60));
  } catch {
    // Fall back gracefully if session info fetch fails
    console.log("─".repeat(60));
  }

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

  // Multi-line input state
  let multiLineMode = false;
  let multiLineBuffer = "";

  const spinner = ora({ text: "Agent is thinking...", spinner: "dots" });
  let thinkingStart = 0;
  let thinkingInterval: ReturnType<typeof setInterval> | null = null;

  function startSpinner() {
    thinkingStart = Date.now();
    spinner.start();
    thinkingInterval = setInterval(() => {
      const elapsed = ((Date.now() - thinkingStart) / 1000).toFixed(0);
      spinner.text = `Agent is thinking... (${elapsed}s)`;
    }, 1000);
  }

  function stopSpinner() {
    if (thinkingInterval) {
      clearInterval(thinkingInterval);
      thinkingInterval = null;
    }
    spinner.stop();
  }

  if (!isRunning) {
    rl.prompt();
  } else {
    startSpinner();
  }

  // Ctrl+C handling
  rl.on("SIGINT", async () => {
    if (isRunning && !interruptSent) {
      interruptSent = true;
      stopSpinner();
      console.log("\n[interrupted — press Ctrl+C again to exit]");
      try {
        await backend.events.send(sessionId, [{ type: "user.interrupt" }]);
      } catch {}
    } else {
      stopSpinner();
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

    // Multi-line mode toggle
    if (trimmed === '"""') {
      if (!multiLineMode) {
        multiLineMode = true;
        multiLineBuffer = "";
        console.log(chalk.dim('  (multi-line mode — type """ on its own line to send)'));
      } else {
        // End multi-line mode and send accumulated buffer
        multiLineMode = false;
        const text = multiLineBuffer.trimEnd();
        multiLineBuffer = "";
        if (!text) {
          if (!isRunning) rl.prompt();
          return;
        }
        try {
          await backend.events.send(sessionId, [{
            type: "user.message",
            content: [{ type: "text", text }],
          }]);
        } catch (err: any) {
          console.error(chalk.red(`Error: ${err.message}`));
          rl.prompt();
        }
      }
      return;
    }

    // Accumulate in multi-line mode
    if (multiLineMode) {
      multiLineBuffer += line + "\n";
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
    stopSpinner();
    console.log();
    process.exit(0);
  });

  // Stream events
  try {
    for await (const evt of backend.events.stream(sessionId, lastSeq)) {
      const evtType = evt.type;

      if (["agent.message", "session.status_idle", "session.error", "session.status_terminated"].includes(evtType)) {
        stopSpinner();
      }

      const needsConfirm = renderEvent(evt, verbose);
      if (needsConfirm) {
        stopSpinner();
        pendingConfirmation = evt;
      }

      if (evtType === "session.status_running") {
        isRunning = true;
        interruptSent = false;
        startSpinner();
      } else if (evtType === "session.status_idle") {
        isRunning = false;
        interruptSent = false;
        stopSpinner();
        rl.prompt();
      } else if (evtType === "session.status_terminated") {
        stopSpinner();
        rl.close();
        return;
      }
    }
  } catch (err: any) {
    stopSpinner();
    console.error(chalk.red(`Stream error: ${err.message}`));
  }

  rl.close();
}
