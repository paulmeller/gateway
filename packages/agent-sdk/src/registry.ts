/**
 * Canonical registry of engines, providers, and required-secret metadata.
 *
 * Single source of truth for:
 *   - Engine list (the harness CLI: claude, opencode, codex, gemini, factory, pi)
 *   - Provider list (sandbox runtime: docker, sprites, e2b, vercel, ...)
 *   - Required secrets per engine and per provider (UI surfaces these as
 *     vault-entry slots at agent create time)
 *
 * Consumers that previously duplicated these lists should import from here:
 *   - zod enums in openapi/schemas.ts and handlers/anthropic-compat/agents.ts
 *   - TypeScript unions in types.ts and backends/types.ts (derive via
 *     `(typeof ENGINES)[number]["id"]`)
 *   - agentstep-product/src/lib/engine-config.ts (re-export from
 *     `@agentstep/agent-sdk`)
 *
 * Adding a new engine or provider should require touching exactly one place:
 * the ENGINES or PROVIDERS array below.
 */

/** Required vault-entry slot for a given engine or provider. */
export interface SecretField {
  /** The vault key name (matches what the backend env-injects). */
  key: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Placeholder shown in the UI input. */
  placeholder: string;
}

export interface EngineInfo {
  /** Engine identifier (matches CliBackendName / agent.engine). */
  id: "claude" | "opencode" | "codex" | "gemini" | "factory" | "pi";
  /** UI display label. */
  label: string;
  /**
   * Default secret slot the agent's vault needs for this engine. Some engines
   * (opencode, pi) derive the slot from the *model* prefix; those carry no
   * default and `getEngineSecret(engine, model)` does the lookup instead.
   */
  defaultSecret?: SecretField;
}

export interface ProviderInfo {
  /** Provider identifier (matches ProviderName). */
  id:
    | "sprites" | "docker" | "podman" | "apple-container" | "apple-firecracker"
    | "e2b" | "vercel" | "daytona" | "fly" | "modal" | "anthropic" | "cloudflare";
  /** UI display label. */
  label: string;
  /** Where this provider runs. Affects discoverability in the UI. */
  kind: "local" | "cloud" | "proxy";
  /**
   * Vault-entry slot needed to talk to this provider (where applicable).
   * Local providers (docker, podman, apple-*) have no secret; sprites and
   * cloud providers do.
   */
  secret?: SecretField;
}

const ANTHROPIC_KEY: SecretField = {
  key: "ANTHROPIC_API_KEY",
  label: "Anthropic API Key",
  placeholder: "sk-ant-... or sk-ant-oat-...",
};

const OPENAI_KEY: SecretField = {
  key: "OPENAI_API_KEY",
  label: "OpenAI API Key",
  placeholder: "sk-...",
};

const GEMINI_KEY: SecretField = {
  key: "GEMINI_API_KEY",
  label: "Gemini API Key",
  placeholder: "AIza...",
};

export const ENGINES: readonly EngineInfo[] = [
  { id: "claude",   label: "Claude",   defaultSecret: ANTHROPIC_KEY },
  { id: "opencode", label: "OpenCode" /* derived from model prefix */ },
  { id: "codex",    label: "Codex",    defaultSecret: OPENAI_KEY },
  { id: "gemini",   label: "Gemini",   defaultSecret: GEMINI_KEY },
  { id: "factory",  label: "Factory",  defaultSecret: ANTHROPIC_KEY },
  { id: "pi",       label: "Pi"        /* derived from model prefix */ },
] as const;

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: "anthropic",         label: "Anthropic (cloud proxy)",   kind: "proxy", secret: ANTHROPIC_KEY },
  { id: "sprites",           label: "Sprites",                   kind: "cloud", secret: { key: "SPRITE_TOKEN",     label: "Sprites.dev Token",     placeholder: "user/org/.../token" } },
  { id: "docker",            label: "Docker (local)",            kind: "local" },
  { id: "podman",            label: "Podman (local)",            kind: "local" },
  { id: "apple-container",   label: "Apple Container (local)",   kind: "local" },
  { id: "apple-firecracker", label: "Apple Firecracker (local)", kind: "local" },
  { id: "e2b",               label: "E2B",                       kind: "cloud", secret: { key: "E2B_API_KEY",      label: "E2B API Key",           placeholder: "e2b_..." } },
  { id: "vercel",            label: "Vercel",                    kind: "cloud", secret: { key: "VERCEL_TOKEN",     label: "Vercel Token",          placeholder: "..." } },
  { id: "fly",               label: "Fly.io",                    kind: "cloud", secret: { key: "FLY_API_TOKEN",    label: "Fly.io API Token",      placeholder: "fo1_..." } },
  { id: "modal",             label: "Modal",                     kind: "cloud", secret: { key: "MODAL_TOKEN_ID",   label: "Modal Token ID",        placeholder: "..." } },
  { id: "daytona",           label: "Daytona",                   kind: "cloud", secret: { key: "DAYTONA_API_KEY", label: "Daytona API Key",       placeholder: "..." } },
  { id: "cloudflare",        label: "Cloudflare Sandbox",        kind: "cloud", secret: { key: "CLOUDFLARE_API_TOKEN", label: "Cloudflare API Token", placeholder: "..." } },
] as const;

/** Engine ids as a tuple suitable for zod's `z.enum(...)` constructor. */
export const ENGINE_NAMES = ENGINES.map((e) => e.id) as readonly EngineInfo["id"][];

/** Provider ids as a tuple suitable for zod's `z.enum(...)` constructor. */
export const PROVIDER_NAMES = PROVIDERS.map((p) => p.id) as readonly ProviderInfo["id"][];

/**
 * Resolve the required vault-entry slot(s) for a given engine + model.
 * `opencode` and `pi` derive the slot from the model prefix; all others
 * use the engine's `defaultSecret`.
 */
export function getEngineSecret(engineId: string, model: string): SecretField | undefined {
  if (engineId === "opencode" || engineId === "pi") {
    if (model.startsWith("openai/")) return OPENAI_KEY;
    if (model.startsWith("google/") || model.startsWith("gemini/")) return GEMINI_KEY;
    return ANTHROPIC_KEY;
  }
  return ENGINES.find((e) => e.id === engineId)?.defaultSecret;
}

/** Lookup the provider's required vault-entry slot, if any. */
export function getProviderSecret(providerId: string): SecretField | undefined {
  return PROVIDERS.find((p) => p.id === providerId)?.secret;
}
