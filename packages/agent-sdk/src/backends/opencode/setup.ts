/**
 * Install opencode on a freshly-created sprite.
 *
 * Idempotent via a sentinel file at OPENCODE_INSTALLED_SENTINEL. First call
 * takes ~10 seconds on sprites.dev's base image.
 * Subsequent calls for the same sprite are instant (sentinel short-circuit).
 *
 * findings:
 * - sprites.dev base image has node v22.20.0 pre-installed via nvm at
 *   `/.sprite/languages/node/nvm/versions/node/v22.20.0/`
 * - `npm install -g opencode-ai` succeeds in 9s and installs opencode-ai@1.4.1
 * - npm creates the symlink `<prefix>/bin/opencode` but that dir is NOT on
 *   the default PATH (only `/.sprite/bin` is)
 * - Workaround: `ln -sf $(npm config get prefix)/bin/opencode /usr/local/bin/opencode`
 *   works without sudo and makes `opencode` directly invokable as
 *   `/usr/local/bin/opencode` (which IS on PATH)
 */
import type { ContainerProvider } from "../../providers/types";
import { installOpencodeWrapper } from "./wrapper-script";

// Use $HOME-relative sentinel so it works on any container runtime
// (sprites.dev HOME=/home/sprite, Docker/Apple HOME=/root or /home/node)
const SENTINEL_NAME = ".claude-agents-opencode-installed";

export async function prepareOpencodeOnSprite(spriteName: string, provider: ContainerProvider): Promise<void> {
  await installOpencodeWrapper(spriteName, provider);

  // Install opencode binary, sentinel-guarded for idempotency.
  // Uses /usr/local/bin/opencode for verification (not `which`) because
  // some container exec contexts have a minimal PATH that doesn't include
  // /usr/local/bin even though the binary is there.
  const script = [
    "set -euo pipefail",
    `SENTINEL="$HOME/${SENTINEL_NAME}"`,
    'if [ -f "$SENTINEL" ]; then exit 0; fi',
    "npm install -g opencode-ai",
    "PREFIX=$(npm config get prefix)",
    // Only symlink if npm prefix differs from /usr/local — otherwise the
    // symlink overwrites npm's existing binary with a circular self-reference.
    // This happens on Docker/Apple containers where PREFIX=/usr/local.
    'if [ "$PREFIX" != "/usr/local" ]; then ln -sf "$PREFIX/bin/opencode" /usr/local/bin/opencode; fi',
    '/usr/local/bin/opencode --version || $PREFIX/bin/opencode --version',
    'touch "$SENTINEL"',
  ].join(" && ");

  const result = await provider.exec(spriteName, ["bash", "-c", script], {
    timeoutMs: 5 * 60_000, // 5 minutes — cold install typically <30s but leave headroom
  });
  if (result.exit_code !== 0) {
    throw new Error(
      `opencode install failed (${result.exit_code}): ${result.stderr.slice(0, 500)}`,
    );
  }
}
