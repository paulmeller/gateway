import { z } from "zod";
import { routeWrap, jsonOk, paginatedOk } from "../http";
import { getDb } from "../db/client";
import {
  createMemoryStore,
  getMemoryStore,
  listMemoryStores,
  deleteMemoryStore,
  updateMemoryStore,
  createOrUpsertMemory,
  getMemory,
  listMemories,
  updateMemory,
  deleteMemory,
  listMemoryVersions,
  getMemoryVersion,
  archiveMemoryStore,
  redactMemoryVersion,
} from "../db/memory";
import { getAgent } from "../db/agents";
import { badRequest, notFound, conflict, tooManyRequests } from "../errors";
import { assertResourceTenant, resolveCreateTenant, tenantFilter } from "../auth/scope";
import type { AuthContext } from "../types";
import { reviewSessions } from "../dreaming/review";
import { getConfig } from "../config";

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
    const requestedLimit = Number(url.searchParams.get("limit") || "100");
    const data = listMemoryStores({
      agent_id: agentId,
      tenantFilter: tenantFilter(auth),
    });
    return paginatedOk(data, requestedLimit);
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

const UpdateStoreSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  metadata: z.record(z.string()).optional(),
});

export function handleUpdateMemoryStore(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadStoreForCaller(auth, id); // tenant guard

    const body = await request.json();
    const parsed = UpdateStoreSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const store = updateMemoryStore(id, parsed.data);
    if (!store) throw notFound(`memory store not found: ${id}`);
    return jsonOk(store);
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
  return routeWrap(request, async ({ auth, request: req }) => {
    loadStoreForCaller(auth, storeId); // tenant guard
    const url = new URL(req.url);
    const requestedLimit = Number(url.searchParams.get("limit") || "100");
    const data = listMemories(storeId);
    return paginatedOk(data, requestedLimit);
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

// ── Memory Versions ─────────────────────────────────────────────────

export function handleListMemoryVersions(request: Request, storeId: string): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    loadStoreForCaller(auth, storeId); // tenant guard
    const url = new URL(req.url);
    const memoryId = url.searchParams.get("memory_id") ?? undefined;
    const requestedLimit = Number(url.searchParams.get("limit") || "100");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const data = listMemoryVersions(storeId, {
      memoryId,
      limit: requestedLimit,
      cursor,
    });
    return paginatedOk(data, requestedLimit);
  });
}

export function handleGetMemoryVersion(request: Request, storeId: string, versionId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadStoreForCaller(auth, storeId); // tenant guard
    const version = getMemoryVersion(storeId, versionId);
    if (!version) throw notFound(`memory version not found: ${versionId}`);
    return jsonOk(version);
  });
}

export function handleRedactMemoryVersion(request: Request, storeId: string, versionId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadStoreForCaller(auth, storeId); // tenant guard
    const version = getMemoryVersion(storeId, versionId);
    if (!version) throw notFound(`memory version not found: ${versionId}`);
    const redacted = redactMemoryVersion(storeId, versionId);
    if (!redacted) throw badRequest(`cannot redact this version: it is the current head of a live memory`);
    const updated = getMemoryVersion(storeId, versionId);
    return jsonOk(updated);
  });
}

export function handleArchiveMemoryStore(request: Request, storeId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadStoreForCaller(auth, storeId); // tenant guard
    const archived = archiveMemoryStore(storeId);
    if (!archived) throw notFound(`memory store not found: ${storeId}`);
    const store = getMemoryStore(storeId);
    return jsonOk(store);
  });
}

// ── Dream ────────────────────────────────────────────────────────────

const DreamRequestSchema = z.object({
  lookback_hours: z.number().min(1).max(720).default(24),
  dry_run: z.boolean().default(false),
  model: z.string().optional(),
  api_key: z.string().optional(),
});

// Per-store cooldown (5 minutes)
const dreamCooldowns = new Map<string, number>();
const DREAM_COOLDOWN_MS = 5 * 60 * 1000;

export function handleDreamMemoryStore(request: Request, storeId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadStoreForCaller(auth, storeId); // tenant guard + existence check

    const body = await request.json();
    const parsed = DreamRequestSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    // Check per-store cooldown
    const lastDreamed = dreamCooldowns.get(storeId);
    if (lastDreamed !== undefined && Date.now() - lastDreamed < DREAM_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((DREAM_COOLDOWN_MS - (Date.now() - lastDreamed)) / 1000);
      throw tooManyRequests(`dream was triggered recently; retry after ${retryAfterSec}s`);
    }

    // Resolve API key: body.api_key || config
    const apiKey = parsed.data.api_key || getConfig().anthropicApiKey;
    if (!apiKey) {
      throw badRequest("No Anthropic API key available. Provide api_key in the request body or set ANTHROPIC_API_KEY.");
    }

    const result = await reviewSessions({
      storeId,
      lookbackMs: parsed.data.lookback_hours * 3_600_000,
      dryRun: parsed.data.dry_run,
      apiKey,
      model: parsed.data.model,
    });

    // Set cooldown after successful run
    dreamCooldowns.set(storeId, Date.now());

    return jsonOk({
      type: "dream_result",
      memory_store_id: storeId,
      session_count: result.sessionCount,
      proposed_changes: result.proposedChanges,
      applied: result.applied,
    });
  });
}
