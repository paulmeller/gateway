import chalk from "chalk";
import { renderMarkdown } from "./render-markdown.js";

/**
 * Renders a managed-agents event to the terminal.
 * Returns true if a tool confirmation prompt is needed.
 */
export function renderEvent(evt: any, verbose: boolean): boolean {
  const type = evt.type;

  switch (type) {
    case "user.message": {
      const text = extractText(evt);
      if (text) console.log(`${chalk.blue.bold("You:")} ${text}`);
      break;
    }

    case "agent.message": {
      const text = extractText(evt);
      if (text) {
        console.log(chalk.green("Agent:"));
        console.log(renderMarkdown(text));
      }
      break;
    }

    case "agent.thinking": {
      if (!verbose) break;
      const text = evt.thinking ?? "";
      if (text) console.log(chalk.dim.italic(`  [thinking] ${truncate(text, 200)}`));
      break;
    }

    case "agent.tool_use": {
      const inputStr = evt.input ? JSON.stringify(evt.input, null, 2) : "";
      const nameLabel = chalk.bold.yellow(evt.name);
      const topBorder = chalk.dim("  ┌ ") + nameLabel + chalk.dim(" " + "─".repeat(Math.max(0, 37 - (evt.name?.length ?? 0))));
      console.log(topBorder);
      if (inputStr) {
        for (const line of inputStr.split("\n")) {
          console.log(chalk.dim("  │ ") + line);
        }
      }
      console.log(chalk.dim("  └" + "─".repeat(39)));
      break;
    }

    case "agent.custom_tool_use": {
      const nameLabel = chalk.bold.yellow(evt.name);
      const topBorder = chalk.dim("  ┌ ") + nameLabel + chalk.dim(" " + "─".repeat(Math.max(0, 37 - (evt.name?.length ?? 0))));
      console.log(topBorder);
      console.log(chalk.dim("  │ ") + chalk.red("⚠ custom tool results not supported in CLI chat"));
      console.log(chalk.dim("  └" + "─".repeat(39)));
      break;
    }

    case "agent.mcp_tool_use": {
      const label = evt.server_name ? `${evt.server_name}/${evt.name}` : evt.name;
      const nameLabel = chalk.bold.yellow(label);
      const topBorder = chalk.dim("  ┌ ") + nameLabel + chalk.dim(" " + "─".repeat(Math.max(0, 37 - (label?.length ?? 0))));
      console.log(topBorder);
      console.log(chalk.dim("  └" + "─".repeat(39)));
      break;
    }

    case "agent.tool_result":
    case "agent.mcp_tool_result": {
      if (!verbose) break;
      const text = extractText(evt);
      if (!text) break;
      const lines = text.split("\n");
      const shown = lines.length > 20 ? [...lines.slice(0, 20), `... (${lines.length - 20} more lines)`] : lines;
      for (const line of shown) console.log(chalk.dim(`  │ ${line}`));
      break;
    }

    case "agent.tool_confirmation_request": {
      const name = evt.tool_name ?? evt.name ?? "unknown";
      process.stdout.write(chalk.yellow.bold(`  [confirm] tool "${name}" — allow? (y/n): `));
      return true;
    }

    case "session.status_running":
      // Handled by caller (spinner)
      break;

    case "session.status_idle":
      // Handled by caller (prompt)
      console.log(chalk.dim("─".repeat(60)));
      break;

    case "session.status_terminated": {
      const reason = evt.stop_reason ?? "unknown";
      console.log(chalk.dim(`Session terminated (reason: ${reason})`));
      break;
    }

    case "session.error": {
      const msg = evt.message ?? "unknown error";
      const errType = evt.error_type;
      if (errType) console.log(chalk.red.bold(`Error [${errType}]: ${msg}`));
      else console.log(chalk.red.bold(`Error: ${msg}`));
      break;
    }

    case "session.thread_started":
      if (verbose) console.log(chalk.dim(`  [thread] started: ${evt.child_session_id}`));
      break;

    case "session.thread_completed":
      if (verbose) console.log(chalk.dim(`  [thread] completed: ${evt.child_session_id}`));
      break;

    case "span.tool_use_begin":
      if (verbose) console.log(chalk.dim(`  ▸ running ${evt.name}...`));
      break;

    case "span.tool_use_end":
      if (verbose) console.log(chalk.dim(`  ▸ ${evt.name} done`));
      break;

    case "span.model_request_end": {
      const usage = evt.usage;
      if (usage) {
        const inTok = (usage.input_tokens ?? 0).toLocaleString();
        const outTok = (usage.output_tokens ?? 0).toLocaleString();
        const cost = usage.cost_usd != null ? ` · $${Number(usage.cost_usd).toFixed(4)}` : "";
        console.log(chalk.dim(`  ↳ ${inTok} in · ${outTok} out${cost}`));
      }
      break;
    }

    // Silent events
    case "span.model_request_start":
    case "span.environment_setup_start":
    case "span.environment_setup_end":
    case "user.tool_confirmation":
    case "user.custom_tool_result":
    case "user.define_outcome":
      break;

    default:
      if (verbose) console.log(chalk.dim(`  [${type}]`));
  }

  return false;
}

function extractText(evt: any): string {
  const content = evt.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}
