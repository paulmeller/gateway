/**
 * Anthropic provider — no-op container provider.
 *
 * When provider is "anthropic", execution is handled by Anthropic's
 * managed agents API via the sync-and-proxy flow. No local containers
 * are created. This provider exists so the registry resolves and
 * availability checks work.
 */
import type { ContainerProvider } from "./types";

export const anthropicProvider: ContainerProvider = {
  name: "anthropic",
  stripControlChars: false,

  async checkAvailability(secrets) {
    const key = secrets?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return { available: false, message: "ANTHROPIC_API_KEY required — add to vault or .env" };
    }
    return { available: true };
  },

  async create() {
    // No-op: Anthropic manages the execution environment
  },

  async delete() {
    // No-op: session archival is handled via proxy
  },

  async list() {
    return []; // No local containers
  },

  async exec() {
    throw new Error("anthropic provider does not support local exec — use the proxy flow");
  },

  async startExec() {
    throw new Error("anthropic provider does not support local exec — use the proxy flow");
  },
};
