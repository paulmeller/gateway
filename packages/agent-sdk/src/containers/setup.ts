/**
 * Async environment setup: package install + checkpoint.
 *
 * Runs in the background after `POST /v1/environments` returns. Creates a
 * fresh template sprite, installs packages per `env.config.packages`, writes
 * an idempotency sentinel, creates a sprites.dev checkpoint, persists the
 * checkpoint id on the environment row, deletes the template sprite, and
 * flips `environments.state` to `ready` (or `failed` on error).
 *
 * Sentinel idempotency pattern from
 * 
 *
 * NOTE: the sentinel path assumes claude runs as user `sprite` with
 * `HOME=/home/sprite`. Spike S1 validates this and may change the path.
 */
import crypto from "node:crypto";
import {
  createSprite,
  deleteSprite,
  httpExec,
  createCheckpoint,
} from "./client";
import {
  CLAUDE_WRAPPER_PATH as WRAPPER_PATH,
  installClaudeWrapper as installWrapper,
} from "../backends/claude/wrapper-script";
import {
  getEnvironmentRow,
  updateEnvironmentCheckpoint,
  updateEnvironmentState,
} from "../db/environments";
import type { EnvironmentConfig } from "../types";
import type { ContainerProvider } from "../providers/types";
import { resolveContainerProvider } from "../providers/registry";
import { newId } from "../util/ids";

const SENTINEL_DIR = "/home/sprite";

function hashPackages(packages: EnvironmentConfig["packages"]): string {
  const canonical = JSON.stringify(packages ?? {}, Object.keys(packages ?? {}).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function buildInstallCommands(packages: EnvironmentConfig["packages"]): string[] {
  if (!packages) return [];
  const cmds: string[] = [];
  // Alphabetical order to match Managed Agents spec behavior.
  if (packages.apt?.length) {
    cmds.push(`apt-get update -qq && apt-get install -y -qq ${packages.apt.map(shellEscape).join(" ")}`);
  }
  if (packages.cargo?.length) {
    cmds.push(`cargo install ${packages.cargo.map(shellEscape).join(" ")}`);
  }
  if (packages.gem?.length) {
    cmds.push(`gem install ${packages.gem.map(shellEscape).join(" ")}`);
  }
  if (packages.go?.length) {
    for (const pkg of packages.go) cmds.push(`go install ${shellEscape(pkg)}`);
  }
  if (packages.npm?.length) {
    cmds.push(`npm install -g ${packages.npm.map(shellEscape).join(" ")}`);
  }
  if (packages.pip?.length) {
    cmds.push(`pip install ${packages.pip.map(shellEscape).join(" ")}`);
  }
  return cmds;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Prepare a freshly-created sprite: install the wrapper script and run
 * the environment's setup commands. Returns when the sentinel is in place.
 */
export async function prepareSprite(
  spriteName: string,
  packages: EnvironmentConfig["packages"],
  provider?: ContainerProvider,
): Promise<void> {
  const p = provider ?? await resolveContainerProvider();
  await installWrapper(spriteName, p);

  const hash = hashPackages(packages);
  const sentinel = `${SENTINEL_DIR}/.claude-agents-setup-${hash}`;
  const installCmds = buildInstallCommands(packages);
  if (installCmds.length === 0) {
    await p.exec(spriteName, ["bash", "-c", `touch ${sentinel}`]);
    return;
  }

  const script = [
    "set -euo pipefail",
    `if [ -f ${sentinel} ]; then exit 0; fi`,
    ...installCmds,
    `touch ${sentinel}`,
  ].join(" && ");

  const result = await p.exec(spriteName, ["bash", "-c", script], {
    timeoutMs: 30 * 60_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(`setup failed (${result.exit_code}): ${result.stderr.slice(0, 500)}`);
  }
}

/**
 * Kick off env setup in the background. Called from `POST /v1/environments`
 * after the response has been sent.
 */
export function kickoffEnvironmentSetup(envId: string): void {
  // Fire-and-forget. Errors are captured onto the environment row.
  runEnvironmentSetup(envId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[env ${envId}] setup failed:`, msg);
    try {
      updateEnvironmentState(envId, "failed", msg);
    } catch (dbErr) {
      console.error(`[env ${envId}] failed to record setup failure:`, dbErr);
    }
  });
}

async function runEnvironmentSetup(envId: string): Promise<void> {
  const row = getEnvironmentRow(envId);
  if (!row) throw new Error(`environment ${envId} not found`);
  if (row.state === "ready") return;

  const config = JSON.parse(row.config_json) as EnvironmentConfig;
  const provider = await resolveContainerProvider(config.provider);
  const hasPackages = config.packages && Object.values(config.packages).some((v) => v && v.length > 0);

  if (!hasPackages) {
    // No packages to install — env is ready immediately. Each session sprite
    // will get the wrapper installed in lifecycle.acquireForFirstTurn().
    updateEnvironmentState(envId, "ready", null);
    return;
  }

  // With packages: create a template container, run installs, then mark ready.
  // NOTE: sprites.dev checkpoints are per-sprite only, so we can't snapshot
  // the template and restore onto session sprites. For now, packages are
  // re-installed per session sprite (slow). M5 will optimize with a sprite
  // pool or alternative approach.
  const templateName = `ca-env-tpl-${newId("env").slice(4, 16).toLowerCase()}`;
  await provider.create({ name: templateName });
  try {
    await prepareSprite(templateName, config.packages, provider);
    // Record that setup succeeded but no checkpoint to share.
    updateEnvironmentState(envId, "ready", null);
  } catch (err) {
    throw err;
  } finally {
    await provider.delete(templateName).catch(() => {});
  }
}

export { WRAPPER_PATH, SENTINEL_DIR };
