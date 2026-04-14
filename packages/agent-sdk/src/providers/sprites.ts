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
  deleteSprite,
  listSprites,
  httpExec,
} from "../containers/client";
import { startExec } from "../containers/exec";
import { getConfig } from "../config/index";

export const spritesProvider: ContainerProvider = {
  name: "sprites",
  stripControlChars: true, // sprites.dev HTTP exec multiplexes stdout/stderr with control bytes

  async checkAvailability(secrets?: ProviderSecrets) {
    const cfg = getConfig();
    if (!(secrets?.SPRITE_TOKEN ?? cfg.spriteToken)) {
      return { available: false, message: "SPRITE_TOKEN required \u2014 add to vault or .env" };
    }
    return { available: true };
  },

  async create({ name, secrets }) {
    await createSprite({ name, tokenOverride: secrets?.SPRITE_TOKEN });
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
