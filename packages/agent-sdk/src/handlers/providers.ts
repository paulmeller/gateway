import { routeWrap, jsonOk } from "../http";
import { resolveContainerProvider } from "../providers/registry";
import { getConfig } from "../config/index";
import type { AvailabilityResult, ProviderName } from "../providers/types";

const LOCAL_PROVIDERS: ProviderName[] = ["docker", "apple-container", "podman"];
const CLOUD_PROVIDERS: ProviderName[] = ["sprites", "e2b", "vercel", "daytona", "fly", "modal"];

const CLOUD_KEY_MAP: Record<string, string> = {
  sprites: "SPRITE_TOKEN",
  e2b: "E2B_API_KEY",
  vercel: "VERCEL_TOKEN",
  daytona: "DAYTONA_API_KEY",
  fly: "FLY_API_TOKEN",
  modal: "MODAL_TOKEN_ID",
};

async function checkLocalProvider(name: ProviderName): Promise<AvailabilityResult> {
  try {
    const provider = await resolveContainerProvider(name);
    if (provider.checkAvailability) {
      return await provider.checkAvailability();
    }
    return { available: true };
  } catch {
    return { available: false, message: `Provider "${name}" could not be loaded` };
  }
}

function checkCloudProvider(name: string): AvailabilityResult {
  const envVar = CLOUD_KEY_MAP[name];
  if (!envVar) return { available: true };

  // Check env var and config (for sprites)
  if (process.env[envVar]) return { available: true };
  if (name === "sprites") {
    const config = getConfig();
    if (config.spriteToken) return { available: true };
  }

  // Token not in env/settings — still available if provided via vault at session time.
  // Mark as available with a note, not as unavailable.
  return {
    available: true,
    message: `${envVar} not found in env or settings. Provide via vault_ids at session creation.`,
  };
}

export async function handleGetProviderStatus(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const results: Record<string, AvailabilityResult> = {};

    const localChecks = LOCAL_PROVIDERS.map(async (name) => {
      results[name] = await checkLocalProvider(name);
    });

    for (const name of CLOUD_PROVIDERS) {
      results[name] = checkCloudProvider(name);
    }

    await Promise.allSettled(localChecks);

    return jsonOk({ data: results });
  });
}
