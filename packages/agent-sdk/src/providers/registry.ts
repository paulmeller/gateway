/**
 * Container provider registry.
 *
 * Resolves a provider by name (from environment config). Defaults to
 * sprites.dev for backward compatibility. Uses lazy dynamic imports
 * so optional SDK-based providers (e2b, vercel) only load when selected.
 */
import type { ContainerProvider, ProviderName } from "./types";

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
};

export async function resolveContainerProvider(
  providerName?: string | null,
): Promise<ContainerProvider> {
  const key = (providerName ?? "sprites") as ProviderName;
  const loader = PROVIDERS[key];
  if (!loader) throw new Error(`Unknown provider: "${key}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
  return loader();
}
