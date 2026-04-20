import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { getDb } from "../db/client";
import {
  createMemoryStore,
  getMemoryStore,
  listMemoryStores,
  deleteMemoryStore,
  createOrUpsertMemory,
  getMemory,
  listMemories,
  updateMemory,
  deleteMemory,
} from "../db/memory";
import { getAgent } from "../db/agents";
import { badRequest, notFound, conflict } from "../errors";
import { assertResourceTenant, resolveCreateTenant, tenantFilter } from "../auth/scope";
import type { AuthContext } from "../types";

// ── Tenant helper for memory stores ──────────────────────────────────

/**
 * Look up the agent that owns this memory store, then assert tenant.
 * Stores with null agent_id (legacy) are global-admin-only.
 */
function assertStoreTenant(auth: AuthContext, storeAgentId: string | null): void {
  if (storeAgentId == null) {
    if (!auth.isGlobalAdmin) throw notFound("memory store not found");
    return;
  }
  const row = getDb()
    .prepare(`SELECT tenant_id FROM agents WHERE id = ?`)
    .get(storeAgentId) as { tenant_id: string | null } | undefined;
  if (!row) throw notFound("memory store not found");
  assertResourceTenant(auth, row.tenant_id, "memory store not found");
}

function loadStoreForCaller(auth: AuthContext, id: string) {
  const store = getMemoryStore(id);
  if (!store) throw notFound(`memory store not found: ${id}`);
  assertStoreTenant(auth, store.agent_id);
  return store;
}

// ── Memory Stores ────────────────────────────────────────────────────

const CreateStoreSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  agent_id: z.string().min(1),
});

export function handleCreateMemoryStore(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const body = await request.json();
    const parsed = CreateStoreSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    // Validate the agent exists and belongs to the caller's tenant.
    const agentRow = getDb()
      .prepare(`SELECT tenant_id FROM agents WHERE id = ?`)
      .get(parsed.data.agent_id) as { tenant_id: string | null } | undefined;
    if (!agentRow) throw notFound(`agent not found: ${parsed.data.agent_id}`);
    assertResourceTenant(auth, agentRow.tenant_id, `agent not found: ${parsed.data.agent_id}`);

    const store = createMemoryStore({
      name: parsed.data.name,
      description: parsed.data.description,
      agent_id: parsed.data.agent_id,
    });
    return jsonOk(store, 201);
  });
}

export function handleListMemoryStores(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const agentId = url.searchParams.get("agent_id") ?? undefined;
    const data = listMemoryStores({
      agent_id: agentId,
      tenantFilter: tenantFilter(auth),
    });
    return jsonOk({ data });
  });
}

export function handleGetMemoryStore(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const store = loadStoreForCaller(auth, id);
    return jsonOk(store);
  });
}

export function handleDeleteMemoryStore(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadStoreForCaller(auth, id); // tenant guard
    const deleted = deleteMemoryStore(id);
    if (!deleted) throw notFound(`memory store not found: ${id}`);
    return jsonOk({ id, type: "memory_store_deleted" });
  });
}

// ── Memories ─────────────────────────────────────────────────────────

const CreateMemorySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const UpdateMemorySchema = z.object({
  content: z.string(),
  content_sha256: z.string().optional(),
});

export function handleCreateMemory(request: Request, storeId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadStoreForCaller(auth, storeId); // tenant guard

    const body = await request.json();
    const parsed = CreateMemorySchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const memory = createOrUpsertMemory(storeId, parsed.data.path, parsed.data.content);
    return jsonOk(memory, 201);
  });
}

export function handleListMemories(request: Request, storeId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadStoreForCaller(auth, storeId); // tenant guard
    const data = listMemories(storeId);
    return jsonOk({ data });
  });
}

export function handleGetMemory(request: Request, storeId: string, memId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadStoreForCaller(auth, storeId); // tenant guard
    const memory = getMemory(memId);
    if (!memory || memory.store_id !== storeId) throw notFound(`memory not found: ${memId}`);
    return jsonOk(memory);
  });
}

export function handleUpdateMemory(request: Request, storeId: string, memId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadStoreForCaller(auth, storeId); // tenant guard

    const body = await request.json();
    const parsed = UpdateMemorySchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const { memory, conflict: isConflict } = updateMemory(
      memId,
      parsed.data.content,
      parsed.data.content_sha256,
    );

    if (isConflict) {
      throw conflict(
        `content_sha256 precondition failed: the memory has been modified since you last read it. Re-read and retry.`,
      );
    }
    if (!memory) throw notFound(`memory not found: ${memId}`);
    return jsonOk(memory);
  });
}

export function handleDeleteMemory(request: Request, storeId: string, memId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadStoreForCaller(auth, storeId); // tenant guard
    const deleted = deleteMemory(memId);
    if (!deleted) throw notFound(`memory not found: ${memId}`);
    return jsonOk({ id: memId, type: "memory_deleted" });
  });
}
