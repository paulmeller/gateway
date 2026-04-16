import * as p from "@clack/prompts";
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

  // Default "no" — destructive defaults on usage data are a bad look.
  // Users who want to help opt in explicitly. Details in docs/telemetry.md.
  const answer = await p.confirm({
    message:
      "Send anonymous command usage to help improve AgentStep Gateway? " +
      "(command name, success, OS, CLI version — no prompts or content. " +
      "See https://github.com/agentstep/gateway/blob/main/docs/telemetry.md)",
    initialValue: false,
  });
  if (p.isCancel(answer)) {
    cfg.telemetry = false;
    saveConfig(cfg);
    return false;
  }

  cfg.telemetry = answer as boolean;
  saveConfig(cfg);

  if (cfg.telemetry) {
    p.log.info("Thanks! You can disable anytime: gateway config set telemetry false");
  }

  return cfg.telemetry;
}
