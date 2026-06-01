/**
 * Models surface — list + retrieve. Mirrors Anthropic CMA's
 * `GET /v1/models` and `GET /v1/models/{model_id}`.
 *
 * List supports filtering by engine/provider/free-text. Retrieve
 * returns the same ModelEntry shape; 404 if the bare-id isn't in
 * the registry.
 */
import { routeWrap, jsonOk } from "../http";
import { notFound } from "../errors";
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

export function handleGetModel(request: Request, modelId: string): Promise<Response> {
  return routeWrap(request, async () => {
    const models = await getModels({});
    const model = models.find((m) => m.id === modelId);
    if (!model) throw notFound(`model not found: ${modelId}`);
    return jsonOk(model);
  });
}
