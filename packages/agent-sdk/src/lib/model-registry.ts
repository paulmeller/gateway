/**
 * Dynamic model registry — fetches available models from provider APIs.
 *
 * Follows the skills-cache.ts pattern: singleton promise + TTL + stale-while-error.
 *
 * Sources (fetched in parallel):
 *   - Anthropic: /v1/models (x-api-key auth)
 *   - OpenAI: /v1/models (bearer auth)
 *   - Google: /v1/models (query key auth)
 *   - Ollama: /api/tags (no auth, 2s timeout)
 *   - OpenRouter: /api/v1/models (no auth, only when OPENROUTER_ENABLED=1)
 *
 * Cache: 4hr TTL, stale-while-error. Falls back to FALLBACK_MODELS when
 * live+stale is empty.
 */
import { getConfig } from "../config";
import { readSetting } from "../config";
import { FALLBACK_MODELS } from "../backends/models";

// --- Types ---

export interface ModelEntry {
  id: string;
  provider: string;
  engines: Record<string, string>;
  context_window?: number;
  local?: boolean;
}

// --- Constants ---

const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CLOUD_TIMEOUT_MS = 10_000;
const OLLAMA_TIMEOUT_MS = 2_000;

// --- Cache ---

interface CacheEntry {
  data: ModelEntry[] | null;
  fetchedAt: number;
  promise: Promise<ModelEntry[]> | null;
}

const cache: CacheEntry = { data: null, fetchedAt: 0, promise: null };

// --- Source definitions ---

function resolveOllamaUrl(): string {
  return process.env.OLLAMA_URL
    || readSetting("ollama_url")
    || "http://localhost:11434";
}

// --- Provider fetchers ---

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAnthropic(apiKey: string): Promise<ModelEntry[]> {
  const res = await fetchWithTimeout(
    "https://api.anthropic.com/v1/models?limit=100",
    { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
    CLOUD_TIMEOUT_MS,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
  return (body.data ?? []).map((m) => ({
    id: m.id,
    provider: "anthropic",
    engines: {
      claude: m.id,
      opencode: `anthropic/${m.id}`,
      pi: `anthropic/${m.id}`,
      factory: m.id,
    },
  }));
}

const OPENAI_CHAT_PREFIXES = ["gpt-", "o1-", "o3-", "o4-", "codex-", "chatgpt-"];

async function fetchOpenAI(apiKey: string): Promise<ModelEntry[]> {
  const res = await fetchWithTimeout(
    "https://api.openai.com/v1/models",
    { headers: { Authorization: `Bearer ${apiKey}` } },
    CLOUD_TIMEOUT_MS,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
  return (body.data ?? [])
    .filter((m) => OPENAI_CHAT_PREFIXES.some((p) => m.id.startsWith(p)))
    .map((m) => ({
      id: m.id,
      provider: "openai",
      engines: {
        codex: m.id,
        opencode: `openai/${m.id}`,
        pi: `openai/${m.id}`,
        factory: m.id,
      },
    }));
}

async function fetchGoogle(apiKey: string): Promise<ModelEntry[]> {
  const res = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey)}`,
    {},
    CLOUD_TIMEOUT_MS,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as {
    models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number }>;
  };
  return (body.models ?? [])
    .filter((m) => m.name.includes("gemini"))
    .map((m) => {
      const id = m.name.replace(/^models\//, "");
      return {
        id,
        provider: "google",
        engines: {
          gemini: id,
          pi: `google/${id}`,
        },
        context_window: m.inputTokenLimit,
      };
    });
}

async function fetchOllama(): Promise<ModelEntry[]> {
  const baseUrl = resolveOllamaUrl();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/tags`,
    {},
    OLLAMA_TIMEOUT_MS,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { models?: Array<{ name: string; size?: number }> };
  return (body.models ?? []).map((m) => ({
    id: m.name,
    provider: "ollama",
    engines: { opencode: m.name },
    local: true,
  }));
}

async function fetchOpenRouter(): Promise<ModelEntry[]> {
  const res = await fetchWithTimeout(
    "https://openrouter.ai/api/v1/models",
    {},
    CLOUD_TIMEOUT_MS,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as {
    data?: Array<{ id: string; context_length?: number }>;
  };
  return (body.data ?? [])
    .filter((m) => {
      // Filter to known chat model provider prefixes
      return (
        m.id.startsWith("anthropic/") ||
        m.id.startsWith("openai/") ||
        m.id.startsWith("google/") ||
        m.id.startsWith("meta-llama/") ||
        m.id.startsWith("mistralai/")
      );
    })
    .map((m) => {
      const engines: Record<string, string> = {};
      if (m.id.startsWith("anthropic/")) {
        const canonical = m.id.replace("anthropic/", "");
        engines.claude = canonical;
        engines.opencode = m.id;
        engines.pi = m.id;
        engines.factory = canonical;
      } else if (m.id.startsWith("openai/")) {
        const canonical = m.id.replace("openai/", "");
        engines.codex = canonical;
        engines.opencode = m.id;
        engines.pi = m.id;
        engines.factory = canonical;
      } else if (m.id.startsWith("google/")) {
        const canonical = m.id.replace("google/", "");
        engines.gemini = canonical;
        engines.pi = m.id;
      } else {
        // Other providers: opencode + pi
        engines.opencode = m.id;
        engines.pi = m.id;
      }
      return {
        id: m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id,
        provider: "openrouter",
        engines,
        context_window: m.context_length,
      };
    });
}

// --- Core fetch logic ---

async function fetchAllModels(): Promise<ModelEntry[]> {
  const cfg = getConfig();
  const fetchers: Promise<ModelEntry[]>[] = [];

  if (cfg.anthropicApiKey) fetchers.push(fetchAnthropic(cfg.anthropicApiKey).catch(() => []));
  if (cfg.openAiApiKey) fetchers.push(fetchOpenAI(cfg.openAiApiKey).catch(() => []));
  if (cfg.geminiApiKey) fetchers.push(fetchGoogle(cfg.geminiApiKey).catch(() => []));
  fetchers.push(fetchOllama().catch(() => []));
  if (process.env.OPENROUTER_ENABLED === "1") {
    fetchers.push(fetchOpenRouter().catch(() => []));
  }

  const results = await Promise.allSettled(fetchers);
  const all: ModelEntry[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }

  // Dedup: prefer Anthropic/OpenAI/Google > Ollama > OpenRouter
  const PRIORITY: Record<string, number> = {
    anthropic: 0,
    openai: 0,
    google: 0,
    ollama: 1,
    openrouter: 2,
  };
  const seen = new Map<string, ModelEntry>();
  // Sort by priority so higher-priority providers win the dedup
  all.sort((a, b) => (PRIORITY[a.provider] ?? 99) - (PRIORITY[b.provider] ?? 99));
  for (const entry of all) {
    if (!seen.has(entry.id)) {
      seen.set(entry.id, entry);
    }
  }
  return Array.from(seen.values());
}

// --- Public API ---

export async function getModels(opts?: {
  engine?: string;
  provider?: string;
  q?: string;
}): Promise<ModelEntry[]> {
  let models = await getModelsFromCache();

  // Filter by engine
  if (opts?.engine) {
    models = models.filter((m) => opts.engine! in m.engines);
  }

  // Filter by provider
  if (opts?.provider) {
    models = models.filter((m) => m.provider === opts.provider);
  }

  // Filter by search query
  if (opts?.q) {
    const q = opts.q.toLowerCase();
    models = models.filter((m) => m.id.toLowerCase().includes(q));
  }

  return models;
}

function getModelsFromCache(): Promise<ModelEntry[]> {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < TTL_MS) {
    return Promise.resolve(cache.data);
  }
  if (cache.promise) return cache.promise;

  cache.promise = fetchAllModels()
    .then((data) => {
      // Always merge fallback models so cloud models are available
      // even when only Ollama returned data (no API keys set).
      const fallback = buildFallbackModels();
      const seen = new Set(data.map((m) => m.id));
      const merged = [...data];
      for (const fb of fallback) {
        if (!seen.has(fb.id)) {
          merged.push(fb);
          seen.add(fb.id);
        }
      }
      cache.data = merged;
      cache.fetchedAt = Date.now();
      return cache.data;
    })
    .catch(() => {
      // Stale-while-error
      if (cache.data) return cache.data;
      // No stale data either — use fallback
      const fallback = buildFallbackModels();
      cache.data = fallback;
      cache.fetchedAt = Date.now();
      return fallback;
    })
    .finally(() => {
      cache.promise = null;
    });
  return cache.promise;
}

/**
 * Build fallback models from the bundled LiteLLM catalog (2,600+ models).
 * Only includes chat/completion models from major providers that work
 * with at least one gateway engine.
 */
function buildFallbackModels(): ModelEntry[] {
  let catalog: Record<string, Record<string, unknown>>;
  try {
    catalog = require("./model-catalog.json") as Record<string, Record<string, unknown>>;
  } catch {
    // Catalog not bundled — fall back to the old hardcoded list
    return buildLegacyFallback();
  }

  const results: ModelEntry[] = [];

  // Provider mapping: litellm_provider → our provider name
  const PROVIDER_MAP: Record<string, string> = {
    anthropic: "anthropic",
    openai: "openai",
    vertex_ai: "google",
    "vertex_ai-language-models": "google",
    gemini: "google",
  };

  // Only include current-generation chat models
  const CHAT_PREFIXES = ["claude-", "gpt-", "o1-", "o3-", "o4-", "chatgpt-", "codex-", "gemini-"];

  // Skip dated snapshots, previews, and legacy versions
  const SKIP_PATTERNS = [
    /\d{4}-?\d{2}-?\d{2}/, // date-stamped snapshots (20250101, 2025-01-01)
    /-preview$/,            // preview builds (keep -preview- in name though)
    /-(0125|0613|1106|0314|0301|0501|0806|1120)$/, // OpenAI date suffixes
    /:/, // Ollama-style tags in catalog
  ];

  for (const [modelId, info] of Object.entries(catalog)) {
    const litellmProvider = (info.litellm_provider ?? "") as string;
    const provider = PROVIDER_MAP[litellmProvider];
    if (!provider) continue;

    // Filter to chat models
    if (!CHAT_PREFIXES.some((p) => modelId.startsWith(p))) continue;

    // Skip snapshots, legacy, and non-chat models
    if (SKIP_PATTERNS.some((re) => re.test(modelId))) continue;
    if (modelId.includes("image") || modelId.includes("tts") || modelId.includes("audio")
      || modelId.includes("transcribe") || modelId.includes("diarize")
      || modelId.includes("realtime") || modelId.includes("search-api")
      || modelId.includes("embedding") || modelId.includes("exp-")
      || modelId.includes("computer-use") || modelId.includes("lite-preview")
      || modelId.startsWith("gpt-3.5") || modelId.startsWith("gpt-4-")
      || (modelId.startsWith("gpt-4o") && !modelId.startsWith("gpt-4o-mini"))
    ) continue;

    const contextWindow = (info.max_input_tokens ?? info.max_tokens) as number | undefined;

    // Build engine mapping
    const engines: Record<string, string> = {};
    if (provider === "anthropic") {
      engines.claude = modelId;
      engines.opencode = `anthropic/${modelId}`;
      engines.pi = `anthropic/${modelId}`;
      engines.factory = modelId;
    } else if (provider === "openai") {
      engines.codex = modelId;
      engines.opencode = `openai/${modelId}`;
      engines.pi = `openai/${modelId}`;
      engines.factory = modelId;
    } else if (provider === "google") {
      engines.gemini = modelId;
      engines.pi = `google/${modelId}`;
    }

    results.push({
      id: modelId,
      provider,
      engines,
      context_window: contextWindow,
    });
  }

  return results;
}

/** Legacy hardcoded fallback — only used if model-catalog.json is missing. */
function buildLegacyFallback(): ModelEntry[] {
  const modelMap = new Map<string, ModelEntry>();
  for (const [engine, models] of Object.entries(FALLBACK_MODELS)) {
    for (const engineModelId of models) {
      let canonicalId = engineModelId;
      let provider = "unknown";
      if (engineModelId.includes("/")) {
        const [prov, id] = engineModelId.split("/", 2);
        canonicalId = id;
        provider = prov === "anthropic" ? "anthropic" : prov === "openai" ? "openai" : prov === "google" ? "google" : prov;
      } else if (canonicalId.startsWith("claude-")) provider = "anthropic";
      else if (canonicalId.match(/^(gpt-|codex-|o[134]-)/)) provider = "openai";
      else if (canonicalId.startsWith("gemini-")) provider = "google";

      const existing = modelMap.get(canonicalId);
      if (existing) { existing.engines[engine] = engineModelId; }
      else { modelMap.set(canonicalId, { id: canonicalId, provider, engines: { [engine]: engineModelId } }); }
    }
  }
  return Array.from(modelMap.values());
}

/** Reset the cache — for testing. */
export function _resetCache(): void {
  cache.data = null;
  cache.fetchedAt = 0;
  cache.promise = null;
}
