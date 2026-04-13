/**
 * Install gemini CLI on a freshly-created sprite.
 *
 * Mirrors codex/setup.ts with the same sentinel + symlink pattern.
 * Gemini CLI is installed via npm from the @google/gemini-cli package.
 */
import type { ContainerProvider } from "../../providers/types";
import { installGeminiWrapper } from "./wrapper-script";

const SENTINEL_NAME = ".claude-agents-gemini-installed";

export async function prepareGeminiOnSprite(spriteName: string, provider: ContainerProvider): Promise<void> {
  await installGeminiWrapper(spriteName, provider);

  const script = [
    "set -euo pipefail",
    `SENTINEL="$HOME/${SENTINEL_NAME}"`,
    'if [ -f "$SENTINEL" ]; then exit 0; fi',
    "npm install -g @google/gemini-cli",
    "PREFIX=$(npm config get prefix)",
    'if [ "$PREFIX" != "/usr/local" ]; then ln -sf "$PREFIX/bin/gemini" /usr/local/bin/gemini; fi',
    '/usr/local/bin/gemini --version || $PREFIX/bin/gemini --version',
    'touch "$SENTINEL"',
  ].join(" && ");

  const result = await provider.exec(spriteName, ["bash", "-c", script], {
    timeoutMs: 5 * 60_000,
  });
  if (result.exit_code !== 0) {
    throw new Error(
      `gemini install failed (${result.exit_code}): ${result.stderr.slice(0, 500)}`,
    );
  }
}
