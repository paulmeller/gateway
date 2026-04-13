import { buildOpenApiDocument } from "../openapi/spec";

function originFromRequest(request: Request): string {
  const headers = request.headers;
  const proto = headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? new URL(request.url).host;
  return `${proto}://${host}`;
}

export async function handleGetOpenApiSpec(request: Request): Promise<Response> {
  const serverUrl = originFromRequest(request);
  const doc = buildOpenApiDocument({ serverUrl });
  return Response.json(doc);
}
