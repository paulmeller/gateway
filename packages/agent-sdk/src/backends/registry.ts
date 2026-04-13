/**
 * Backend registry: maps a backend name to its concrete implementation.
 *
 * Kept in its own file so types.ts and the concrete backends can import the
 * type definitions without circular dependencies. The driver imports only
 * from here.
 */
import type { Backend, BackendName } from "./types";
import { claudeBackend } from "./claude";
import { opencodeBackend } from "./opencode";
import { codexBackend } from "./codex";
import { geminiBackend } from "./gemini";
import { factoryBackend } from "./factory";

const BACKENDS: Record<BackendName, Backend> = {
  claude: claudeBackend,
  opencode: opencodeBackend,
  codex: codexBackend,
  gemini: geminiBackend,
  factory: factoryBackend,
};

/**
 * Resolve a backend by name, defaulting to claude for undefined input.
 * Throws if the name is set but unknown.
 */
export function resolveBackend(
  name: BackendName | string | null | undefined,
): Backend {
  const key = (name ?? "claude") as BackendName;
  const b = BACKENDS[key];
  if (!b) throw new Error(`unknown backend: ${name}`);
  return b;
}

export function listBackends(): BackendName[] {
  return Object.keys(BACKENDS) as BackendName[];
}
