/**
 * Post-turn memory store sync.
 *
 * After a turn completes, reads files from `/mnt/memory/<store>/` in the
 * container and compares them to the DB. New files are created, changed
 * files are updated, and files absent from the container are deleted.
 *
 * Only runs for `memory_store` resources with `access: "read_write"`.
 * Best-effort — errors are logged but do not fail the turn.
 */
import type { ContainerProvider, ProviderSecrets } from "../providers/types";

/**
 * Select the memory_store resources that may be written back after a turn:
 * only those attached `read_write`. A `read_only` store (e.g. a peer channel's
 * store borrowed for cross-channel reads) is never written. Pure — exported so
 * the read-only guarantee can be unit-tested without a live container.
 */
export function selectWritableMemoryResources<
  T extends { type: string; memory_store_id?: string | null; access?: string },
>(resources: T[]): T[] {
  return resources.filter(
    (r) => r.type === "memory_store" && !!r.memory_store_id && r.access === "read_write",
  );
}

export async function syncMemoryStores(opts: {
  sessionId: string;
  sandboxName: string;
  provider: ContainerProvider;
  secrets?: ProviderSecrets;
}): Promise<void> {
  const { sessionId, sandboxName, provider, secrets } = opts;

  const { listResources } = await import("../db/session-resources");
  const { getMemoryStore, listMemories, createOrUpsertMemory, getMemoryByPath, deleteMemory } = await import("../db/memory");

  const resources = listResources(sessionId);
  const memStoreResources = selectWritableMemoryResources(resources);

  if (memStoreResources.length === 0) return;

  for (const r of memStoreResources) {
    const store = getMemoryStore(r.memory_store_id!);
    if (!store) continue;

    const storeName = store.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const storeDir = `/mnt/memory/${storeName}`;

    // List files in the container
    let containerPaths: string[];
    try {
      const result = await provider.exec(
        sandboxName,
        ["find", storeDir, "-type", "f"],
        { secrets, timeoutMs: 10000 },
      );
      if (result.exit_code !== 0 || !result.stdout.trim()) {
        containerPaths = [];
      } else {
        const clean = result.stdout.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
        containerPaths = clean.trim().split("\n").map(l => l.trim()).filter(Boolean);
      }
    } catch (err) {
      console.warn(`[memory-sync] failed to list files in ${storeDir}:`, err);
      continue;
    }

    // Build a map of relative path -> container absolute path
    const prefix = storeDir.endsWith("/") ? storeDir : `${storeDir}/`;
    const containerFileMap = new Map<string, string>();
    for (const absPath of containerPaths) {
      if (absPath.startsWith(prefix)) {
        const relPath = absPath.slice(prefix.length);
        if (relPath) containerFileMap.set(relPath, absPath);
      }
    }

    // Read current DB memories
    const dbMemories = listMemories(store.id);
    const dbMemoryMap = new Map(dbMemories.map(m => [m.path, m]));

    // Sync container -> DB
    for (const [relPath, absPath] of containerFileMap) {
      try {
        const result = await provider.exec(
          sandboxName,
          ["cat", "--", absPath],
          { secrets, timeoutMs: 10000 },
        );
        if (result.exit_code !== 0) continue;
        const content = result.stdout.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

        const existing = dbMemoryMap.get(relPath);
        if (existing) {
          // Only update if content actually changed
          if (existing.content !== content) {
            createOrUpsertMemory(store.id, relPath, content, sessionId);
          }
        } else {
          // New file in container
          createOrUpsertMemory(store.id, relPath, content, sessionId);
        }
      } catch (err) {
        console.warn(`[memory-sync] failed to read ${absPath}:`, err);
      }
    }

    // Delete DB memories not found in container
    for (const [path, mem] of dbMemoryMap) {
      if (!containerFileMap.has(path)) {
        try {
          deleteMemory(mem.id, sessionId);
        } catch (err) {
          console.warn(`[memory-sync] failed to delete memory ${mem.id}:`, err);
        }
      }
    }
  }
}
