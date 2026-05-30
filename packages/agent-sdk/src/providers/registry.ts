/**
 * Container provider registry.
 *
 * Resolves a provider by name (from environment config). Defaults to
 * sprites.dev for backward compatibility. Uses lazy dynamic imports
 * so optional SDK-based providers (e2b, vercel) only load when selected.
 */
import type { ContainerProvider, ProviderName } from "./types";
import { getConfig } from "../config";

const PROVIDERS: Record<ProviderName, () => Promise<ContainerProvider>> = {
  sprites: async () => (await import("./sprites")).spritesProvider,
  docker: async () => (await import("./docker")).dockerProvider,
  "apple-container": async () => (await import("./apple-container")).appleProvider,
  "apple-firecracker": async () => (await import("./apple-firecracker")).mvmProvider,
  podman: async () => (await import("./podman")).podmanProvider,
  e2b: async () => (await import("./e2b")).e2bProvider,
  vercel: async () => (await import("./vercel")).vercelProvider,
  daytona: async () => (await import("./daytona")).daytonaProvider,
  fly: async () => (await import("./fly")).flyProvider,
  modal: async () => (await import("./modal")).modalProvider,
  mvm: async () => (await import("./apple-firecracker")).mvmProvider,
  anthropic: async () => (await import("./anthropic")).anthropicProvider,
  cloudflare: async () => (await import("./cloudflare")).cloudflareProvider,
};

export async function resolveContainerProvider(
  providerName?: string | null,
): Promise<ContainerProvider> {
  if (!providerName) throw new Error("No container provider specified — set provider in the environment config");
  const key = providerName as ProviderName;
  const loader = PROVIDERS[key];
  if (!loader) throw new Error(`Unknown provider: "${key}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
  return loader();
}

/**
 * Resolve a container provider with precedence:
 * 1. Explicit override (from function param)
 * 2. Environment config provider (per-env, the historical default)
 * 3. Process default (DEFAULT_PROVIDER env var or --provider flag)
 * 4. Throw if throwOnMissing, else return null
 *
 * The per-env `config.provider` field used to log a "deprecated" warning,
 * but it's genuinely the only way to support mixed-provider deployments
 * (e.g. one env on `sprites`, another on `apple-container`) in a single
 * gateway process. Keeping the path; dropping the warning. Use
 * `DEFAULT_PROVIDER` as the catch-all when an env doesn't specify one.
 *
 * Use resolveProvider() for execution paths (throws on missing).
 * Use tryResolveProvider() for background tasks (returns null on missing).
 */
export async function resolveProvider(opts?: {
  override?: string;
  envConfigProvider?: string | null;
}): Promise<ContainerProvider> {
  const result = await tryResolveProvider(opts);
  if (!result) {
    throw new Error(
      "No container provider configured. Set DEFAULT_PROVIDER env var, use gateway serve --provider <name>, or gateway worker --provider <name>."
    );
  }
  return result;
}

export async function tryResolveProvider(opts?: {
  override?: string;
  envConfigProvider?: string | null;
}): Promise<ContainerProvider | null> {
  // 1. Explicit override
  if (opts?.override) {
    return resolveContainerProvider(opts.override);
  }

  // 2. Per-env config (set at environment-create time)
  if (opts?.envConfigProvider) {
    return resolveContainerProvider(opts.envConfigProvider);
  }

  // 3. Process default
  const cfg = getConfig();
  if (cfg.defaultProvider) {
    return resolveContainerProvider(cfg.defaultProvider);
  }

  // 4. Not found
  return null;
}

/**
 * Get provider name string with same precedence (for non-async contexts).
 */
export function resolveProviderName(opts?: {
  override?: string;
  envConfigProvider?: string | null;
}): string {
  if (opts?.override) return opts.override;
  if (opts?.envConfigProvider) return opts.envConfigProvider;
  const cfg = getConfig();
  if (cfg.defaultProvider) return cfg.defaultProvider;
  return "unknown";
}
