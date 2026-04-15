import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isTelemetryEnabled } from "./consent.js";

const ENDPOINT = "https://api.agentstep.com/v1/telemetry";

function getCliVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
    return pkg.version;
  } catch {
    return "dev";
  }
}

export function trackCommand(event: {
  command: string;
  backendType?: string;
  provider?: string;
  success: boolean;
}): void {
  if (!isTelemetryEnabled()) return;

  const payload = {
    event: "cli.command",
    command: event.command,
    backend_type: event.backendType ?? "local",
    provider: event.provider,
    success: event.success,
    cli_version: getCliVersion(),
    os: process.platform,
    arch: process.arch,
    node_version: process.version,
    timestamp: new Date().toISOString(),
  };

  fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}
