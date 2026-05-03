import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "yaml";

export interface CliConfig {
  "api-key"?: string;
  "base-url"?: string;
  output?: string;
  telemetry?: boolean;
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "agentstep");
  return join(homedir(), ".config", "agentstep");
}

export function configPath(): string {
  return join(configDir(), "config.yaml");
}

export function loadConfig(): CliConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return parse(readFileSync(path, "utf-8")) ?? {};
  } catch {
    return {};
  }
}

export function saveConfig(cfg: CliConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), stringify(cfg), { mode: 0o600 });
}

export function effectiveApiKey(cfg: CliConfig): string {
  return process.env.GATEWAY_API_KEY || cfg["api-key"] || "";
}

export function effectiveBaseUrl(cfg: CliConfig): string {
  return process.env.GATEWAY_BASE_URL || cfg["base-url"] || "http://localhost:3000";
}

export function effectiveOutput(cfg: CliConfig): string {
  return process.env.GATEWAY_OUTPUT || cfg.output || "table";
}

export function configSet(key: string, value: string): void {
  const valid = ["api-key", "base-url", "output", "telemetry"];
  if (!valid.includes(key)) throw new Error(`Unknown config key: ${key} (valid: ${valid.join(", ")})`);
  const cfg = loadConfig();
  if (key === "telemetry") {
    cfg.telemetry = value === "true";
  } else {
    (cfg as Record<string, string>)[key] = value;
  }
  saveConfig(cfg);
}

export function configGet(key: string): string {
  const cfg = loadConfig();
  switch (key) {
    case "api-key": return effectiveApiKey(cfg);
    case "base-url": return effectiveBaseUrl(cfg);
    case "output": return effectiveOutput(cfg);
    case "telemetry": return cfg.telemetry === true ? "true" : cfg.telemetry === false ? "false" : "(not set)";
    default: throw new Error(`Unknown config key: ${key}`);
  }
}

export function configUnset(key: string): void {
  const cfg = loadConfig();
  delete (cfg as Record<string, string>)[key];
  saveConfig(cfg);
}

export function maskKey(key: string): string {
  if (!key) return "(not set)";
  if (key.length <= 8) return "****";
  return key.slice(0, 8) + "****";
}
