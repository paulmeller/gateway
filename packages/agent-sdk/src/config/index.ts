/**
 * Config cascade: env → settings table → defaults, 30s cache.
 *
 * Inspired by 
 */
import { eq } from "drizzle-orm";
import { getDrizzle, schema } from "../db/drizzle";
import { nowMs } from "../util/clock";

export interface Config {
  spriteToken: string | undefined;
  spriteApi: string;
  anthropicApiKey: string | undefined;
  claudeToken: string | undefined;
  openAiApiKey: string | undefined;
  geminiApiKey: string | undefined;
  factoryApiKey: string | undefined;
  defaultModel: string;
  agentMaxTurns: number;
  agentTimeoutMs: number;
  spriteTimeoutMs: number;
  concurrency: number;
  maxSpritesPerEnv: number;
  sessionMaxAgeMs: number;
  sweeperIntervalMs: number;
  /** OTLP/HTTP endpoint for trace export (OTEL_EXPORTER_OTLP_ENDPOINT). */
  otlpEndpoint: string | undefined;
  /** Optional auth header for OTLP export (e.g. "Bearer ..."). */
  otlpAuthorization: string | undefined;
  /** Comma-separated env-var names whose values must be redacted from payloads. */
  redactEnvKeys: string[];
}

type GlobalCache = typeof globalThis & {
  __caConfigCache?: { at: number; value: Config };
};
const g = globalThis as GlobalCache;

const CACHE_MS = 30_000;

export function readSetting(key: string): string | undefined {
  try {
    const db = getDrizzle();
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    return (row as { value: string | null } | undefined)?.value ?? undefined;
  } catch {
    return undefined;
  }
}

function num(env: string | undefined, fallback: number): number {
  if (env == null) return fallback;
  const n = Number(env);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(): Config {
  return {
    spriteToken: process.env.SPRITE_TOKEN || readSetting("sprite_token"),
    spriteApi:
      process.env.SPRITE_API || readSetting("sprite_api") || "https://api.sprites.dev",
    anthropicApiKey:
      process.env.ANTHROPIC_API_KEY || readSetting("anthropic_api_key"),
    claudeToken:
      process.env.CLAUDE_CODE_OAUTH_TOKEN || readSetting("claude_token"),
    openAiApiKey:
      process.env.OPENAI_API_KEY || readSetting("openai_api_key"),
    geminiApiKey:
      process.env.GEMINI_API_KEY || readSetting("gemini_api_key") || undefined,
    factoryApiKey:
      process.env.FACTORY_API_KEY || readSetting("factory_api_key") || undefined,
    defaultModel:
      process.env.DEFAULT_MODEL ||
      readSetting("default_model") ||
      "claude-sonnet-4-6",
    agentMaxTurns: num(process.env.AGENT_MAX_TURNS, 10),
    agentTimeoutMs: num(process.env.AGENT_TIMEOUT_MS, 600_000),
    spriteTimeoutMs: num(process.env.SPRITE_TIMEOUT_MS, 30_000),
    concurrency: num(process.env.CONCURRENCY, 4),
    maxSpritesPerEnv: num(process.env.MAX_SPRITES_PER_ENV, 8),
    sessionMaxAgeMs: num(process.env.SESSION_MAX_AGE_MS, 7 * 24 * 3600 * 1000),
    sweeperIntervalMs: num(process.env.SWEEPER_INTERVAL_MS, 60_000),
    otlpEndpoint:
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      process.env.OTLP_ENDPOINT ||
      readSetting("otlp_endpoint") ||
      undefined,
    otlpAuthorization:
      process.env.OTEL_EXPORTER_OTLP_HEADERS_AUTHORIZATION ||
      process.env.OTLP_AUTHORIZATION ||
      readSetting("otlp_authorization") ||
      undefined,
    redactEnvKeys: (
      process.env.OBS_REDACT_KEYS ||
      readSetting("obs_redact_keys") ||
      ""
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export function getConfig(): Config {
  const now = nowMs();
  if (g.__caConfigCache && now - g.__caConfigCache.at < CACHE_MS) {
    return g.__caConfigCache.value;
  }
  const value = loadConfig();
  g.__caConfigCache = { at: now, value };
  return value;
}

export function invalidateConfigCache(): void {
  g.__caConfigCache = undefined;
}

export function writeSetting(key: string, value: string): void {
  const db = getDrizzle();
  const now = nowMs();
  db.insert(schema.settings)
    .values({ key, value, updated_at: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updated_at: now } })
    .run();
  invalidateConfigCache();
}

/** Map of provider token env var names → settings DB keys */
const TOKEN_TO_SETTING: Record<string, string> = {
  SPRITE_TOKEN: "sprite_token",
  ANTHROPIC_API_KEY: "anthropic_api_key",
  OPENAI_API_KEY: "openai_api_key",
  GEMINI_API_KEY: "gemini_api_key",
  FACTORY_API_KEY: "factory_api_key",
};

export function writeTokenSetting(envVarName: string, value: string): void {
  const settingKey = TOKEN_TO_SETTING[envVarName];
  if (settingKey) {
    writeSetting(settingKey, value);
  }
}

/**
 * Provider env var fallback — read from env first, then the settings DB.
 * Used by provider modules so credentials stored via the quickstart
 * wizard (which writes to settings) are picked up without the user
 * having to re-export them on every shell.
 *
 * Snake-cased setting key derived from the env var name:
 *   VERCEL_TEAM_ID → vercel_team_id
 *   MODAL_TOKEN_SECRET → modal_token_secret
 */
export function readEnvOrSetting(envVarName: string): string | undefined {
  const fromEnv = process.env[envVarName];
  if (fromEnv) return fromEnv;
  const settingKey = envVarName.toLowerCase();
  return readSetting(settingKey) || undefined;
}
