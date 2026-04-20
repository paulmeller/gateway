/**
 * /v1/license — public license info endpoint.
 *
 * Returns the plan (community/enterprise) and enabled features so the
 * UI can show/hide enterprise controls. No auth required — the plan
 * tier isn't a secret. The raw license key is never returned.
 */
import { routeWrap, jsonOk } from "../http";
import { getLicenseInfo } from "../license";

export function handleGetLicense(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    return jsonOk(getLicenseInfo());
  });
}
