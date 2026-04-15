/**
 * Install factory (droid) CLI on a freshly-created sprite.
 *
 * Mirrors codex/setup.ts with the same sentinel + symlink pattern.
 * Factory CLI is installed via npm from the @factory/cli package.
 */
import type { ContainerProvider } from "../../providers/types";
import { installFactoryWrapper } from "./wrapper-script";

const SENTINEL_NAME = ".claude-agents-factory-installed";

export async function prepareFactoryOnSprite(spriteName: string, provider: ContainerProvider): Promise<void> {
  await installFactoryWrapper(spriteName, provider);

  const script = [
    "set -euo pipefail",
    `SENTINEL="$HOME/${SENTINEL_NAME}"`,
    'if [ -f "$SENTINEL" ]; then exit 0; fi',
    "npm install -g @factory/cli",
    "PREFIX=$(npm config get prefix)",
    'if [ "$PREFIX" != "/usr/local" ]; then ln -sf "$PREFIX/bin/droid" /usr/local/bin/droid; fi',
    '/usr/local/bin/droid --version || $PREFIX/bin/droid --version',
    'touch "$SENTINEL"',
  ].join(" && ");

  const result = await provider.exec(spriteName, ["bash", "-c", script], {
    timeoutMs: 5 * 60_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(
      `factory install failed (${result.exit_code}): ${result.stderr.slice(0, 500)}`,
    );
  }
}
