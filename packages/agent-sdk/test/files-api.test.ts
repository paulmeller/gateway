/**
 * Files API compatibility tests.
 *
 * Covers:
 *   - File response shape (type, mime_type, size_bytes, downloadable)
 *   - File list pagination envelope (has_more, first_id, last_id)
 *   - File list cursor pagination (after_id)
 *   - File list scope filtering
 *   - File list dedup by container_path
 *   - File get returns correct shape
 *   - File download returns content
 *   - File delete returns correct shape
 *   - Resource create returns sesrsc_* ID
 *   - Resource list returns from table
 *   - Resource get by ID
 *   - Resource delete by ID
 *   - Resource limit enforcement (100)
 *   - Session response includes resources from table
 *   - Mount path defaults to /mnt/session/uploads/<file_id>/<filename>
 *   - downloadable is true for local and remote files
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-filesapi-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.FILE_STORAGE_DIR = path.join(dir, "files");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
    __caLicense?: unknown;
    __caDrizzle?: unknown;
  };
  delete g.__caDb;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  delete g.__caActors;
  delete g.__caLicense;
  delete g.__caDrizzle;
}

/** Create prerequisite rows: agent + env + session, returns session ID and API key. */
async function seedSession(): Promise<{ sessionId: string; key: string }> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  const { nowMs } = await import("../src/util/clock");
  const now = nowMs();
  const db = getDb();

  db.prepare(
    `INSERT INTO agents (id, current_version, name, created_at, updated_at)
     VALUES ('agent_fa', 1, 'fa-agent', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO agent_versions (agent_id, version, model, tools_json, mcp_servers_json, backend, webhook_events_json, skills_json, model_config_json, created_at)
     VALUES ('agent_fa', 1, 'claude-sonnet-4-6', '[]', '{}', 'claude', '[]', '[]', '{}', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, created_at)
     VALUES ('env_fa', 'fa-env', '{}', 'ready', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, created_at, updated_at)
     VALUES ('sess_fa', 'agent_fa', 1, 'env_fa', 'idle', '{}', ?, ?)`,
  ).run(now, now);

  const { key } = createApiKey({
    name: "admin",
    permissions: { admin: true, scope: null },
    rawKey: "ck_test_filesapi_admin",
  });

  return { sessionId: "sess_fa", key };
}

// ─── File response shape ──────────────────────────────────────────────────

describe("File response shape", () => {
  beforeEach(() => freshDbEnv());

  it("upload returns correct shape (type, mime_type, size_bytes, downloadable)", async () => {
    const { key, sessionId } = await seedSession();
    const { handleUploadFile } = await import("../src/handlers/files");

    const formData = new FormData();
    formData.append("file", new File(["hello world"], "test.txt", { type: "text/plain" }));

    const res = await handleUploadFile(
      new Request(`http://localhost/v1/files?scope_id=${sessionId}&scope_type=session`, {
        method: "POST",
        headers: { "x-api-key": key },
        body: formData,
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.type).toBe("file");
    expect(body.mime_type).toBe("text/plain");
    expect(body.size_bytes).toBe(11);
    expect(body.downloadable).toBe(true);
    expect(body.id).toBeTruthy();
    expect((body.id as string).startsWith("file_")).toBe(true);
    // Old fields should NOT be present
    expect(body).not.toHaveProperty("content_type");
    expect(body).not.toHaveProperty("size");
  });

  it("downloadable is true for remote files", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    const { createFile } = await import("../src/db/files");

    const file = createFile({
      filename: "remote.txt",
      size: 100,
      content_type: "text/plain",
      storage_path: "remote:file_abc",
      scope: { type: "session", id: "sess_fa" },
    });

    expect(file.downloadable).toBe(true);
    expect(file.type).toBe("file");
  });
});

// ─── File list pagination ─────────────────────────────────────────────────

describe("File list pagination", () => {
  beforeEach(() => freshDbEnv());

  it("returns pagination envelope (has_more, first_id, last_id)", async () => {
    const { key, sessionId } = await seedSession();
    const { handleListFiles } = await import("../src/handlers/files");

    const res = await handleListFiles(
      new Request(`http://localhost/v1/files?scope_id=${sessionId}`, {
        headers: { "x-api-key": key },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("has_more");
    expect(body).toHaveProperty("first_id");
    expect(body).toHaveProperty("last_id");
    expect(body.has_more).toBe(false);
    expect(body.first_id).toBeNull();
    expect(body.last_id).toBeNull();
  });

  it("after_id cursor returns next page", async () => {
    await seedSession();
    const { createFile, listFiles } = await import("../src/db/files");

    // Create 3 files
    const f1 = createFile({ filename: "a.txt", size: 1, content_type: "text/plain", storage_path: "p1", scope: { type: "session", id: "sess_fa" } });
    const f2 = createFile({ filename: "b.txt", size: 1, content_type: "text/plain", storage_path: "p2", scope: { type: "session", id: "sess_fa" } });
    const f3 = createFile({ filename: "c.txt", size: 1, content_type: "text/plain", storage_path: "p3", scope: { type: "session", id: "sess_fa" } });

    // Get first page (limit 2)
    const page1 = listFiles({ limit: 2, scope_id: "sess_fa" });
    expect(page1.data.length).toBe(2);
    expect(page1.has_more).toBe(true);
    expect(page1.first_id).toBeTruthy();
    expect(page1.last_id).toBeTruthy();

    // Get second page using cursor
    const page2 = listFiles({ limit: 2, scope_id: "sess_fa", before_id: page1.last_id! });
    expect(page2.data.length).toBe(1);
    expect(page2.has_more).toBe(false);
  });

  it("scope_id filters correctly", async () => {
    await seedSession();
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    const { nowMs } = await import("../src/util/clock");
    const now = nowMs();

    // Create a second session
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, created_at, updated_at)
       VALUES ('sess_fa2', 'agent_fa', 1, 'env_fa', 'idle', '{}', ?, ?)`,
    ).run(now, now);

    const { createFile, listFiles } = await import("../src/db/files");

    createFile({ filename: "s1.txt", size: 1, content_type: "text/plain", storage_path: "p1", scope: { type: "session", id: "sess_fa" } });
    createFile({ filename: "s2.txt", size: 1, content_type: "text/plain", storage_path: "p2", scope: { type: "session", id: "sess_fa2" } });

    const result1 = listFiles({ scope_id: "sess_fa" });
    expect(result1.data.length).toBe(1);
    expect(result1.data[0].filename).toBe("s1.txt");

    const result2 = listFiles({ scope_id: "sess_fa2" });
    expect(result2.data.length).toBe(1);
    expect(result2.data[0].filename).toBe("s2.txt");
  });

  it("deduplicates container-synced files by container_path", async () => {
    await seedSession();
    const { createFile, listFiles } = await import("../src/db/files");

    // Two versions of same container file
    createFile({ filename: "main.ts", size: 100, content_type: "text/typescript", storage_path: "p1", scope: { type: "session", id: "sess_fa" }, container_path: "/root/main.ts", content_hash: "aaa" });
    createFile({ filename: "main.ts", size: 200, content_type: "text/typescript", storage_path: "p2", scope: { type: "session", id: "sess_fa" }, container_path: "/root/main.ts", content_hash: "bbb" });
    // Also add a file without container_path (uploaded file) — should always be included
    createFile({ filename: "upload.txt", size: 50, content_type: "text/plain", storage_path: "p3", scope: { type: "session", id: "sess_fa" } });

    const result = listFiles({ scope_id: "sess_fa" });
    // Should return 2: one deduped container file + one uploaded file
    expect(result.data.length).toBe(2);
    // The uploaded file should be included
    expect(result.data.some((f) => f.filename === "upload.txt")).toBe(true);
    // Only one version of the container file should be included
    expect(result.data.filter((f) => f.filename === "main.ts").length).toBe(1);
  });
});

// ─── File get/download/delete ─────────────────────────────────────────────

describe("File get/download/delete", () => {
  beforeEach(() => freshDbEnv());

  it("get returns correct shape", async () => {
    const { key, sessionId } = await seedSession();
    const { createFile } = await import("../src/db/files");
    const { handleGetFile } = await import("../src/handlers/files");

    const file = createFile({ filename: "get.txt", size: 5, content_type: "text/plain", storage_path: "p1", scope: { type: "session", id: sessionId } });

    const res = await handleGetFile(
      new Request(`http://localhost/v1/files/${file.id}`, {
        headers: { "x-api-key": key },
      }),
      file.id,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.type).toBe("file");
    expect(body.mime_type).toBe("text/plain");
    expect(body.size_bytes).toBe(5);
    expect(body.downloadable).toBe(true);
  });

  it("download returns content", async () => {
    const { key, sessionId } = await seedSession();
    const { handleUploadFile, handleGetFileContent } = await import("../src/handlers/files");

    const formData = new FormData();
    formData.append("file", new File(["file content here"], "dl.txt", { type: "text/plain" }));

    const uploadRes = await handleUploadFile(
      new Request(`http://localhost/v1/files?scope_id=${sessionId}&scope_type=session`, {
        method: "POST",
        headers: { "x-api-key": key },
        body: formData,
      }),
    );
    const uploaded = await uploadRes.json() as { id: string };

    const dlRes = await handleGetFileContent(
      new Request(`http://localhost/v1/files/${uploaded.id}/content`, {
        headers: { "x-api-key": key },
      }),
      uploaded.id,
    );

    expect(dlRes.status).toBe(200);
    const text = await dlRes.text();
    expect(text).toBe("file content here");
  });

  it("delete returns { id, type: file_deleted }", async () => {
    const { key, sessionId } = await seedSession();
    const { handleUploadFile, handleDeleteFile } = await import("../src/handlers/files");

    const formData = new FormData();
    formData.append("file", new File(["x"], "del.txt", { type: "text/plain" }));

    const uploadRes = await handleUploadFile(
      new Request(`http://localhost/v1/files?scope_id=${sessionId}&scope_type=session`, {
        method: "POST",
        headers: { "x-api-key": key },
        body: formData,
      }),
    );
    const uploaded = await uploadRes.json() as { id: string };

    const delRes = await handleDeleteFile(
      new Request(`http://localhost/v1/files/${uploaded.id}`, {
        method: "DELETE",
        headers: { "x-api-key": key },
      }),
      uploaded.id,
    );

    expect(delRes.status).toBe(200);
    const body = await delRes.json() as Record<string, unknown>;
    expect(body.id).toBe(uploaded.id);
    expect(body.type).toBe("file_deleted");
  });
});

// ─── Session resources ────────────────────────────────────────────────────

describe("Session resources (table-backed)", () => {
  beforeEach(() => freshDbEnv());

  it("create returns sesrsc_* ID with correct shape", async () => {
    const { key, sessionId } = await seedSession();
    const { handleAddResource } = await import("../src/handlers/resources");

    const res = await handleAddResource(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ type: "file", file_id: "file_test123" }),
      }),
      sessionId,
    );

    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect((body.id as string).startsWith("sesrsc_")).toBe(true);
    expect(body.type).toBe("file");
    expect(body.file_id).toBe("file_test123");
    expect(body.session_id).toBe(sessionId);
    expect(body.created_at).toBeTruthy();
    expect(body.updated_at).toBeTruthy();
  });

  it("list returns resources from table", async () => {
    const { key, sessionId } = await seedSession();
    const { handleAddResource, handleListResources } = await import("../src/handlers/resources");

    // Add two resources
    await handleAddResource(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ type: "file", file_id: "file_1" }),
      }),
      sessionId,
    );
    await handleAddResource(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ type: "github_repository", repository_url: "https://github.com/test/repo", branch: "main" }),
      }),
      sessionId,
    );

    const listRes = await handleListResources(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources`, {
        headers: { "x-api-key": key },
      }),
      sessionId,
    );

    expect(listRes.status).toBe(200);
    const body = await listRes.json() as { data: Array<Record<string, unknown>> };
    expect(body.data.length).toBe(2);
    expect((body.data[0].id as string).startsWith("sesrsc_")).toBe(true);
    expect((body.data[1].id as string).startsWith("sesrsc_")).toBe(true);
  });

  it("get by ID works", async () => {
    const { key, sessionId } = await seedSession();
    const { handleAddResource, handleGetResource } = await import("../src/handlers/resources");

    const addRes = await handleAddResource(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ type: "file", file_id: "file_get" }),
      }),
      sessionId,
    );
    const added = await addRes.json() as { id: string };

    const getRes = await handleGetResource(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources/${added.id}`, {
        headers: { "x-api-key": key },
      }),
      sessionId,
      added.id,
    );

    expect(getRes.status).toBe(200);
    const body = await getRes.json() as Record<string, unknown>;
    expect(body.id).toBe(added.id);
    expect(body.file_id).toBe("file_get");
  });

  it("delete by ID works", async () => {
    const { key, sessionId } = await seedSession();
    const { handleAddResource, handleDeleteResource } = await import("../src/handlers/resources");

    const addRes = await handleAddResource(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ type: "file", file_id: "file_del" }),
      }),
      sessionId,
    );
    const added = await addRes.json() as { id: string };

    const delRes = await handleDeleteResource(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources/${added.id}`, {
        method: "DELETE",
        headers: { "x-api-key": key },
      }),
      sessionId,
      added.id,
    );

    expect(delRes.status).toBe(200);
    const body = await delRes.json() as Record<string, unknown>;
    expect(body.id).toBe(added.id);
    expect(body.type).toBe("session_resource_deleted");
  });

  it("enforces 100 resource limit", async () => {
    const { sessionId } = await seedSession();
    const { createResource, countResources } = await import("../src/db/session-resources");

    // Insert 100 resources directly
    for (let i = 0; i < 100; i++) {
      createResource(sessionId, { type: "file", file_id: `file_${i}` });
    }

    expect(countResources(sessionId)).toBe(100);

    // 101st should fail via handler
    const { createApiKey } = await import("../src/db/api_keys");
    const { key } = createApiKey({
      name: "admin2",
      permissions: { admin: true, scope: null },
      rawKey: "ck_test_filesapi_admin2",
    });

    const { handleAddResource } = await import("../src/handlers/resources");
    const res = await handleAddResource(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ type: "file", file_id: "file_overflow" }),
      }),
      sessionId,
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/100/);
  });

  it("session response includes resources from table", async () => {
    const { key, sessionId } = await seedSession();
    const { handleAddResource } = await import("../src/handlers/resources");

    await handleAddResource(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ type: "file", file_id: "file_in_session" }),
      }),
      sessionId,
    );

    const { handleGetSession } = await import("../src/handlers/sessions");
    const sessRes = await handleGetSession(
      new Request(`http://localhost/v1/sessions/${sessionId}`, {
        headers: { "x-api-key": key },
      }),
      sessionId,
    );

    expect(sessRes.status).toBe(200);
    const session = await sessRes.json() as { resources: Array<Record<string, unknown>> };
    expect(session.resources.length).toBe(1);
    expect(session.resources[0].type).toBe("file");
    expect(session.resources[0].file_id).toBe("file_in_session");
  });

  it("github_repository resource has checkout field", async () => {
    const { key, sessionId } = await seedSession();
    const { handleAddResource, handleGetResource } = await import("../src/handlers/resources");

    const addRes = await handleAddResource(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources`, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ type: "github_repository", repository_url: "https://github.com/test/repo", branch: "main" }),
      }),
      sessionId,
    );
    const added = await addRes.json() as { id: string };

    const getRes = await handleGetResource(
      new Request(`http://localhost/v1/sessions/${sessionId}/resources/${added.id}`, {
        headers: { "x-api-key": key },
      }),
      sessionId,
      added.id,
    );

    const body = await getRes.json() as Record<string, unknown>;
    expect(body.type).toBe("github_repository");
    expect(body.url).toBe("https://github.com/test/repo");
    const checkout = body.checkout as { type: string; name: string };
    expect(checkout.type).toBe("branch");
    expect(checkout.name).toBe("main");
  });
});
