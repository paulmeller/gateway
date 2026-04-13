import { routeWrap, jsonOk } from "../http";
import { writeSetting } from "../config";
import { badRequest } from "../errors";

export function handlePutSetting(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const body = await request.json().catch(() => null) as { key?: string; value?: string } | null;
    if (!body?.key || typeof body.value !== "string") {
      throw badRequest("key and value are required");
    }

    const ALLOWED_KEYS = [
      "sprite_token", "anthropic_api_key", "openai_api_key",
      "gemini_api_key", "factory_api_key", "claude_token",
      "e2b_api_key", "vercel_token", "daytona_api_key",
      "fly_api_token", "modal_token_id",
    ];
    if (!ALLOWED_KEYS.includes(body.key)) {
      throw badRequest(`setting "${body.key}" is not writable via API`);
    }

    writeSetting(body.key, body.value);
    return jsonOk({ ok: true });
  });
}
