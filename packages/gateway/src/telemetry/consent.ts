import { createInterface } from "node:readline";
import { loadConfig, saveConfig } from "../config/file.js";

function envDisabled(): boolean {
  return process.env.DO_NOT_TRACK === "1" || process.env.GATEWAY_NO_TELEMETRY === "1";
}

export function isTelemetryEnabled(): boolean {
  if (envDisabled()) return false;
  return loadConfig().telemetry === true;
}

export async function ensureTelemetryConsent(): Promise<boolean> {
  const cfg = loadConfig();

  if (envDisabled()) {
    if (cfg.telemetry === undefined) {
      cfg.telemetry = false;
      saveConfig(cfg);
    }
    return false;
  }

  if (cfg.telemetry !== undefined) return cfg.telemetry;

  // Non-interactive — default to disabled
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    cfg.telemetry = false;
    saveConfig(cfg);
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("Help improve AgentStep by sending anonymous usage data? (y/n) ", resolve);
  });
  rl.close();

  cfg.telemetry = answer.trim().toLowerCase().startsWith("y");
  saveConfig(cfg);

  if (cfg.telemetry) {
    console.log("Thanks! You can disable anytime: gateway config set telemetry false\n");
  }

  return cfg.telemetry;
}
