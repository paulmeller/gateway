/**
 * Install the pi.dev coding agent on a freshly-created sprite.
 *
 * Mirrors gemini/factory setup with the same sentinel + symlink pattern.
 * pi is distributed as the `@mariozechner/pi-coding-agent` npm package and
 * exposes a `pi` binary. See https://shittycodingagent.ai/ for project info.
 */
import type { ContainerProvider } from "../../providers/types";
import { installPiWrapper } from "./wrapper-script";

const SENTINEL_NAME = ".claude-agents-pi-installed";

export async function preparePiOnSprite(spriteName: string, provider: ContainerProvider): Promise<void> {
  await installPiWrapper(spriteName, provider);

  const script = [
    "set -euo pipefail",
    `SENTINEL="$HOME/${SENTINEL_NAME}"`,
    'if [ -f "$SENTINEL" ]; then exit 0; fi',
    "npm install -g @mariozechner/pi-coding-agent",
    "PREFIX=$(npm config get prefix)",
    'if [ "$PREFIX" != "/usr/local" ]; then ln -sf "$PREFIX/bin/pi" /usr/local/bin/pi; fi',
    '/usr/local/bin/pi --version || $PREFIX/bin/pi --version',
    'touch "$SENTINEL"',
  ].join(" && ");

  const result = await provider.exec(spriteName, ["bash", "-c", script], {
    timeoutMs: 5 * 60_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(
      `pi install failed (${result.exit_code}): ${result.stderr.slice(0, 500)}`,
    );
  }
}
