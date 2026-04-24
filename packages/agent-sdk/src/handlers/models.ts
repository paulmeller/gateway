/**
 * GET /v1/models — List available models from provider APIs.
 *
 * Supports query params:
 *   - engine: filter to models compatible with a specific engine
 *   - provider: filter by provider (anthropic, openai, google, ollama, openrouter)
 *   - q: free-text search on model ID
 */
import { routeWrap, jsonOk } from "../http";
import { getModels } from "../lib/model-registry";

export function handleListModels(request: Request): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
    const url = new URL(req.url);
    const engine = url.searchParams.get("engine") ?? undefined;
    const provider = url.searchParams.get("provider") ?? undefined;
    const q = url.searchParams.get("q") ?? undefined;
    const models = await getModels({ engine, provider, q });
    return jsonOk({ data: models });
  });
}
