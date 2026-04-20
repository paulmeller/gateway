import { routeWrap, jsonOk } from "../http";
import { getDb } from "../db/client";
import { getSession, listSessions } from "../db/sessions";
import { notFound } from "../errors";
import { assertResourceTenant, tenantFilter } from "../auth/scope";

export function handleListThreads(request: Request, sessionId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const row = getDb()
      .prepare(`SELECT tenant_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { tenant_id: string | null } | undefined;
    if (!row) throw notFound(`session ${sessionId} not found`);
    assertResourceTenant(auth, row.tenant_id, `session ${sessionId} not found`);
    const session = getSession(sessionId);
    if (!session) throw notFound(`session ${sessionId} not found`);

    const url = new URL(request.url);
    const limit = url.searchParams.get("limit");
    const order = url.searchParams.get("order") as "asc" | "desc" | null;

    const data = listSessions({
      parent_session_id: sessionId,
      limit: limit ? Number(limit) : undefined,
      order: order ?? undefined,
      includeArchived: true, // show all threads including completed ones
      tenantFilter: tenantFilter(auth),
    });

    return jsonOk({
      data,
      next_page: data.length > 0 ? data[data.length - 1].id : null,
    });
  });
}
