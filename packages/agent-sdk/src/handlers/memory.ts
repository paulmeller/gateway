import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
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
import { badRequest, notFound, conflict } from "../errors";

// ── Memory Stores ─────────────────────────────────────────���──────────────

const CreateStoreSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export function handleCreateMemoryStore(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const body = await request.json();
    const parsed = CreateStoreSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const store = createMemoryStore({
      name: parsed.data.name,
      description: parsed.data.description,
    });
    return jsonOk(store, 201);
  });
}

export function handleListMemoryStores(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const data = listMemoryStores();
    return jsonOk({ data });
  });
}

export function handleGetMemoryStore(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    const store = getMemoryStore(id);
    if (!store) throw notFound(`memory store not found: ${id}`);
    return jsonOk(store);
  });
}

export function handleDeleteMemoryStore(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    const deleted = deleteMemoryStore(id);
    if (!deleted) throw notFound(`memory store not found: ${id}`);
    return jsonOk({ id, type: "memory_store_deleted" });
  });
}

// ── Memories ─────────────────────────────────────────────────────────────

const CreateMemorySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const UpdateMemorySchema = z.object({
  content: z.string(),
  content_sha256: z.string().optional(),
});

export function handleCreateMemory(request: Request, storeId: string): Promise<Response> {
  return routeWrap(request, async () => {
    const store = getMemoryStore(storeId);
    if (!store) throw notFound(`memory store not found: ${storeId}`);

    const body = await request.json();
    const parsed = CreateMemorySchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const memory = createOrUpsertMemory(storeId, parsed.data.path, parsed.data.content);
    return jsonOk(memory, 201);
  });
}

export function handleListMemories(request: Request, storeId: string): Promise<Response> {
  return routeWrap(request, async () => {
    const store = getMemoryStore(storeId);
    if (!store) throw notFound(`memory store not found: ${storeId}`);

    const data = listMemories(storeId);
    return jsonOk({ data });
  });
}

export function handleGetMemory(request: Request, storeId: string, memId: string): Promise<Response> {
  return routeWrap(request, async () => {
    const store = getMemoryStore(storeId);
    if (!store) throw notFound(`memory store not found: ${storeId}`);

    const memory = getMemory(memId);
    if (!memory || memory.store_id !== storeId) throw notFound(`memory not found: ${memId}`);
    return jsonOk(memory);
  });
}

export function handleUpdateMemory(request: Request, storeId: string, memId: string): Promise<Response> {
  return routeWrap(request, async () => {
    const store = getMemoryStore(storeId);
    if (!store) throw notFound(`memory store not found: ${storeId}`);

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
  return routeWrap(request, async () => {
    const store = getMemoryStore(storeId);
    if (!store) throw notFound(`memory store not found: ${storeId}`);

    const deleted = deleteMemory(memId);
    if (!deleted) throw notFound(`memory not found: ${memId}`);
    return jsonOk({ id: memId, type: "memory_deleted" });
  });
}
