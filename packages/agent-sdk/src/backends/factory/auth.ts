/**
 * Auth env + create-time validation for the factory backend.
 *
 * Factory CLI reads FACTORY_API_KEY from the environment. We forward it
 * from config.factoryApiKey (which cascades from process.env.FACTORY_API_KEY
 * or the settings table).
 */
import { getConfig } from "../../config";

export function buildFactoryAuthEnv(): Record<string, string> {
  const cfg = getConfig();
  const env: Record<string, string> = {};
  if (cfg.factoryApiKey) {
    env.FACTORY_API_KEY = cfg.factoryApiKey;
  }
  return env;
}

/**
 * Returns null if factory can run, or an error message if it can't. Used at
 * agent create time (validateAgentCreation) and first-turn time
 * (validateRuntime).
 */
export function validateFactoryRuntime(): string | null {
  const cfg = getConfig();
  if (!cfg.factoryApiKey) {
    return "factory backend requires FACTORY_API_KEY to be set";
  }
  return null;
}
