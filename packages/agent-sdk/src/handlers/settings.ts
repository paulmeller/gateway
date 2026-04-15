import { routeWrap, jsonOk } from "../http";
import { writeSetting, readSetting } from "../config";
import { badRequest, notFound } from "../errors";

const ALLOWED_KEYS = [
  "sprite_token", "anthropic_api_key", "openai_api_key",
  "gemini_api_key", "factory_api_key", "claude_token",
  "e2b_api_key", "vercel_token", "daytona_api_key",
  "fly_api_token", "modal_token_id",
  "saved_repositories",
];

export function handlePutSetting(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const body = await request.json().catch(() => null) as { key?: string; value?: string } | null;
    if (!body?.key || typeof body.value !== "string") {
      throw badRequest("key and value are required");
    }

    if (!ALLOWED_KEYS.includes(body.key)) {
      throw badRequest(`setting "${body.key}" is not writable via API`);
    }

    writeSetting(body.key, body.value);
    return jsonOk({ ok: true });
  });
}

export function handleGetSetting(request: Request, key: string): Promise<Response> {
  return routeWrap(request, async () => {
    if (!ALLOWED_KEYS.includes(key)) {
      throw badRequest(`setting "${key}" is not readable via API`);
    }
    const value = readSetting(key);
    if (value === undefined) {
      return jsonOk({ key, value: null });
    }
    return jsonOk({ key, value });
  });
}
