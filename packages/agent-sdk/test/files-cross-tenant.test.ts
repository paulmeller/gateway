/**
 * Regression test for cross-tenant file access. The architect's PR9
 * review flagged a concern that the files-table path might lack
 * tenant isolation. A closer audit (this commit) showed the SDK
 * file handlers (`handleGetFile`, `handleGetFileContent`,
 * `handleListFiles`, `handleDeleteFile`) all guard via
 * `assertFileTenantByScope`, which joins to `sessions.tenant_id`
 * and asserts via `assertResourceTenant`.
 *
 * This test exists to **prove the guard works** and **catch a future
 * regression** if anyone refactors the handlers, the join, or the
 * `assertResourceTenant` precedence rules. Without these tests, a
 * silent regression (e.g. someone removes the join in a "cleanup"
 * PR) would expose tenant-B files to tenant-A callers.
 *
 * Two cases:
 *   1. tenant-A's scoped key cannot read a file scoped to tenant-B's
 *      session (handleGetFileContent → 404, never the bytes).
 *   2. tenant-A's scoped key cannot enumerate files scoped to
 *      tenant-B's session via the list endpoint (404 on the
 *      scope_id, not an empty list — surfacing typos and probes).
 *
 * Both cases verify a positive control too: tenant-B's own key
 * successfully reads its file.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-files-xt-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown; __caDrizzle?: unknown; __caInitialized?: unknown;
    __caInitPromise?: unknown; __caBusEmitters?: unknown;
    __caConfigCache?: unknown; __caRuntime?: unknown;
    __caSweeperHandle?: unknown; __caActors?: unknown; __caLicense?: unknown;
  };
  delete g.__caDb; delete g.__caDrizzle; delete g.__caInitialized;
  delete g.__caInitPromise; delete g.__caBusEmitters; delete g.__caConfigCache;
  delete g.__caRuntime;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  delete g.__caActors; delete g.__caLicense;
}

/**
 * Seed a tenant with one session and one session-scoped file. The
 * file's bytes are written to disk so handleGetFileContent has
 * something real to attempt to read.
 *
 * Returns the scoped api key for that tenant + the session/file ids.
 */
async function seedTenantWithFile(
  tenantId: string,
  storageDir: string,
): Promise<{ key: string; sessionId: string; fileId: string }> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createTenant } = await import("../src/db/tenants");
  const { createApiKey } = await import("../src/db/api_keys");
  const { createFile } = await import("../src/db/files");
  const { nowMs } = await import("../src/util/clock");
  const now = nowMs();
  const db = getDb();

  try { createTenant({ id: tenantId, name: tenantId }); } catch { /* exists */ }

  // Agent + env + session, all in this tenant
  const agentId = `agent_${tenantId}`;
  const envId = `env_${tenantId}`;
  const sessionId = `sess_${tenantId}`;
  db.prepare(
    `INSERT INTO agents (id, current_version, name, tenant_id, created_at, updated_at)
     VALUES (?, 1, 'a', ?, ?, ?)`,
  ).run(agentId, tenantId, now, now);
  db.prepare(
    `INSERT INTO agent_versions (agent_id, version, model, tools_json, mcp_servers_json, backend, webhook_events_json, skills_json, model_config_json, created_at)
     VALUES (?, 1, 'claude-sonnet-4-6', '[]', '{}', 'claude', '[]', '[]', '{}', ?)`,
  ).run(agentId, now);
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at)
     VALUES (?, 'e', '{}', 'ready', ?, ?)`,
  ).run(envId, tenantId, now);
  db.prepare(
    `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, tenant_id, created_at, updated_at)
     VALUES (?, ?, 1, ?, 'idle', '{}', ?, ?, ?)`,
  ).run(sessionId, agentId, envId, tenantId, now, now);

  // Write a real file to disk so handleGetFileContent has bytes
  const storagePath = path.join(storageDir, `${tenantId}-secret.txt`);
  fs.writeFileSync(storagePath, `SECRET DATA FOR ${tenantId}`);
  const record = createFile({
    filename: `${tenantId}-secret.txt`,
    size: fs.statSync(storagePath).size,
    content_type: "text/plain",
    storage_path: storagePath,
    scope: { type: "session", id: sessionId },
  });

  const { key } = createApiKey({
    name: `${tenantId}-scoped`,
    permissions: { admin: true, scope: null },
    tenantId,
    rawKey: `ck_test_${tenantId}_xxx`,
  });

  return { key, sessionId, fileId: record.id };
}

function reqGet(apiKey: string, urlPath: string): Request {
  return new Request(`http://localhost${urlPath}`, {
    headers: { "x-api-key": apiKey },
  });
}

describe("Files — cross-tenant access regression guard", () => {
  let storageDir: string;

  beforeEach(() => {
    freshDbEnv();
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-files-xt-store-"));
  });

  it("1. tenant-A's key cannot fetch a file scoped to tenant-B's session", async () => {
    const tenantA = await seedTenantWithFile("tenant_a", storageDir);
    const tenantB = await seedTenantWithFile("tenant_b", storageDir);

    const { handleGetFileContent, handleGetFile } = await import(
      "../src/handlers/anthropic-compat/files"
    );

    // Positive control: tenant-B's own key can read its file
    const positiveRes = await handleGetFileContent(
      reqGet(tenantB.key, `/anthropic/v1/files/${tenantB.fileId}/content`),
      tenantB.fileId,
    );
    expect(positiveRes.status).toBe(200);
    const body = await positiveRes.text();
    expect(body).toBe("SECRET DATA FOR tenant_b");

    // Cross-tenant: tenant-A's key tries to read tenant-B's file.
    // Must 404 — `assertResourceTenant` throws notFound on mismatch.
    const xtContent = await handleGetFileContent(
      reqGet(tenantA.key, `/anthropic/v1/files/${tenantB.fileId}/content`),
      tenantB.fileId,
    );
    expect(xtContent.status).toBe(404);
    const xtBody = await xtContent.text();
    expect(xtBody).not.toContain("SECRET DATA FOR tenant_b");

    // Same guard on metadata (handleGetFile, not just GetFileContent)
    const xtMeta = await handleGetFile(
      reqGet(tenantA.key, `/anthropic/v1/files/${tenantB.fileId}`),
      tenantB.fileId,
    );
    expect(xtMeta.status).toBe(404);
  });

  it("2. tenant-A's key cannot enumerate files scoped to tenant-B's session", async () => {
    await seedTenantWithFile("tenant_a", storageDir);
    const tenantB = await seedTenantWithFile("tenant_b", storageDir);

    const { handleListFiles } = await import(
      "../src/handlers/anthropic-compat/files"
    );

    // Cross-tenant list attempt: tenant-A's key with scope_id pointing at
    // tenant-B's session. Must 404 (not empty list) so probing for
    // valid-but-foreign session ids gets a clear rejection rather than
    // a silent empty response.
    const xtList = await handleListFiles(
      reqGet(
        (await seedTenantWithFile("tenant_a2", storageDir)).key,
        `/anthropic/v1/files?scope_id=${tenantB.sessionId}`,
      ),
    );
    expect(xtList.status).toBe(404);
  });
});
