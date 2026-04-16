/**
 * Install codex on a freshly-created sprite.
 *
 * Mirrors lib/backends/opencode/setup.ts with the same sentinel + symlink
 * fix pattern Codex is installed via npm from the
 * @openai/codex package.
 *
 * 
 */
import type { ContainerProvider } from "../../providers/types";
import { installCodexWrapper } from "./wrapper-script";

const SENTINEL_NAME = ".claude-agents-codex-installed";

export async function prepareCodexOnSprite(spriteName: string, provider: ContainerProvider): Promise<void> {
  await installCodexWrapper(spriteName, provider);

  const script = [
    "set -euo pipefail",
    `SENTINEL="$HOME/${SENTINEL_NAME}"`,
    'if [ -f "$SENTINEL" ]; then exit 0; fi',
    "npm install -g @openai/codex",
    "PREFIX=$(npm config get prefix)",
    'if [ "$PREFIX" != "/usr/local" ]; then ln -sf "$PREFIX/bin/codex" /usr/local/bin/codex; fi',
    '/usr/local/bin/codex --version || $PREFIX/bin/codex --version',
    'touch "$SENTINEL"',
  ].join(" && ");

  const result = await provider.exec(spriteName, ["bash", "-c", script], {
    timeoutMs: 5 * 60_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(
      `codex install failed (${result.exit_code}): ${result.stderr.slice(0, 500)}`,
    );
  }
}
