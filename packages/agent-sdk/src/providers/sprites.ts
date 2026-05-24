/**
 * Sprites.dev container provider.
 *
 * Wraps the existing `containers/client.ts` + `containers/exec.ts`
 * (formerly `sprite/`) functions behind the `ContainerProvider` interface.
 * No logic changes — just delegation with secrets threading.
 */
import type { ContainerProvider, ProviderSecrets } from "./types";
import {
  createSprite,
  getSprite,
  deleteSprite,
  listSprites,
  httpExec,
} from "../containers/client";
import { startExec } from "../containers/exec";
import { getConfig } from "../config/index";

const READY_POLL_INTERVAL_MS = 500;
const READY_POLL_TIMEOUT_MS = 30_000;

export const spritesProvider: ContainerProvider = {
  name: "sprites",
  stripControlChars: true, // sprites.dev HTTP exec multiplexes stdout/stderr with control bytes
  supportsWarmPool: true,

  async checkAvailability(secrets?: ProviderSecrets) {
    const cfg = getConfig();
    if (!(secrets?.SPRITE_TOKEN ?? cfg.spriteToken)) {
      return { available: false, message: "SPRITE_TOKEN required \u2014 add to vault or .env" };
    }
    return { available: true };
  },

  async create({ name, secrets }) {
    const token = secrets?.SPRITE_TOKEN;
    const sprite = await createSprite({ name, tokenOverride: token });
    if (sprite.status === "warm" || sprite.status === "running") return;

    // Container is cold — poll until it transitions to "warm" or "running".
    // Sprites containers go cold → warm (ready for exec) → running (active exec).
    // Most containers become warm within a few seconds.
    const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
      const s = await getSprite(name, token);
      if (s?.status === "warm" || s?.status === "running") return;
    }
    throw new Error(`sprites.dev container ${name} not ready after 30s`);
  },

  async delete(name, secrets?) {
    await deleteSprite(name, secrets?.SPRITE_TOKEN);
  },

  async list(opts) {
    const res = await listSprites({
      prefix: opts?.prefix,
      max_results: 100,
    });
    return res.sprites.map((s) => ({ name: s.name }));
  },

  async exec(name, argv, opts) {
    return httpExec(name, argv, {
      stdin: opts?.stdin,
      timeoutMs: opts?.timeoutMs,
      tokenOverride: opts?.secrets?.SPRITE_TOKEN,
    });
  },

  startExec(name, opts) {
    return startExec(name, opts);
  },
};
