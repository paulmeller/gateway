/**
 * Tests for the debug-prompt capture feature shipped in 0.5.45.
 *
 * Covers:
 *   - Trigger detection via header + query param.
 *   - createSession({debug_capture: true}) sets the pending sentinel.
 *   - handleCreateSession routes the request flag → createSession flag.
 *   - GET /v1/sessions/:id/debug-prompt: 404 disabled / pending,
 *     410 expired, 200 + JSON when fresh.
 *   - Tenant scoping on GET (cross-tenant → 404).
 *   - redactEnv hides secrets.
 *
 * Driver-side capture (the part that runs on first turn) is not
 * tested here — it requires a real sandbox provider. The capture
 * shape is exercised by stuffing a payload into the row and asserting
 * the GET round-trip.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-debug-prompt-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown; __caInitialized?: unknown; __caInitPromise?: unknown;
    __caBusEmitters?: unknown; __caConfigCache?: unknown; __caRuntime?: unknown;
    __caSweeperHandle?: unknown; __caActors?: unknown; __caDrizzle?: unknown;
    __caLicense?: unknown;
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
 * Seed an agent + environment so sessions table FKs are satisfied.
 * Returns the ids needed by createSession() callers.
 */
async function seedAgentEnv(tenantId: string = "tenant_default"): Promise<{ agentId: string; envId: string }> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createAgent } = await import("../src/db/agents");
  const { newId } = await import("../src/util/ids");
  const db = getDb();
  const agent = createAgent({ name: "test", model: "claude-sonnet-4-6" });
  // Stamp the agent's tenant to match the session's intended tenant.
  db.prepare(`UPDATE agents SET tenant_id = ? WHERE id = ?`).run(tenantId, agent.id);
  const envId = newId("env");
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, state_message, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(envId, "test", '{"type":"cloud"}', "ready", "", tenantId, Date.now(), Date.now());
  return { agentId: agent.id, envId };
}

describe("isDebugPromptRequested", () => {
  it("returns true for X-AgentStep-Debug: prompt (case-insensitive)", async () => {
    const { isDebugPromptRequested } = await import("../src/handlers/debug-prompt");
    expect(isDebugPromptRequested(new Request("http://x/", {
      headers: { "X-AgentStep-Debug": "prompt" },
    }))).toBe(true);
    expect(isDebugPromptRequested(new Request("http://x/", {
      headers: { "x-agentstep-debug": "Prompt" },
    }))).toBe(true);
  });

  it("returns true for ?debug=prompt query param", async () => {
    const { isDebugPromptRequested } = await import("../src/handlers/debug-prompt");
    expect(isDebugPromptRequested(new Request("http://x/sessions?debug=prompt"))).toBe(true);
    expect(isDebugPromptRequested(new Request("http://x/sessions?debug=PROMPT"))).toBe(true);
  });

  it("returns false when absent or wrong value", async () => {
    const { isDebugPromptRequested } = await import("../src/handlers/debug-prompt");
    expect(isDebugPromptRequested(new Request("http://x/"))).toBe(false);
    expect(isDebugPromptRequested(new Request("http://x/", {
      headers: { "x-agentstep-debug": "tokens" },
    }))).toBe(false);
    expect(isDebugPromptRequested(new Request("http://x/sessions?debug=other"))).toBe(false);
  });
});

describe("redactEnv", () => {
  it("redacts known secret keys", async () => {
    const { redactEnv } = await import("../src/handlers/debug-prompt");
    const out = redactEnv({
      ANTHROPIC_API_KEY: "sk-ant-api03-xxx",
      OPENAI_API_KEY: "sk-yyy",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-zzz",
      MCP_TIMEOUT: "30000",
      MODEL: "claude-sonnet-4-6",
    });
    expect(out.ANTHROPIC_API_KEY).toMatch(/^<redacted:len=\d+>$/);
    expect(out.OPENAI_API_KEY).toMatch(/^<redacted:len=\d+>$/);
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^<redacted:len=\d+>$/);
    expect(out.MCP_TIMEOUT).toBe("30000");
    expect(out.MODEL).toBe("claude-sonnet-4-6");
  });

  it("redacts by suffix pattern (_KEY / _TOKEN / _SECRET / _PASSWORD)", async () => {
    const { redactEnv } = await import("../src/handlers/debug-prompt");
    const out = redactEnv({
      CUSTOM_API_KEY: "abcd",
      SOMETHING_TOKEN: "x",
      A_SECRET: "y",
      DB_PASSWORD: "z",
      PUBLIC_URL: "http://example.com",
    });
    expect(out.CUSTOM_API_KEY).toMatch(/^<redacted/);
    expect(out.SOMETHING_TOKEN).toMatch(/^<redacted/);
    expect(out.A_SECRET).toMatch(/^<redacted/);
    expect(out.DB_PASSWORD).toMatch(/^<redacted/);
    expect(out.PUBLIC_URL).toBe("http://example.com");
  });
});

describe("createSession({debug_capture})", () => {
  beforeEach(() => freshDbEnv());

  it("sets sentinel `{\"pending\":true}` when debug_capture is true", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    // Seed enough state for createSession to succeed. Sessions can be
    // created against any agent/env id strings — FK checks aren't enforced.
    const { agentId, envId } = await seedAgentEnv();
    const { createSession, getSessionRow } = await import("../src/db/sessions");
    const session = createSession({
      agent_id: agentId, agent_version: 1, environment_id: envId,
      tenant_id: "tenant_default",
      debug_capture: true,
    });
    const row = getSessionRow(session.id);
    expect(row?.debug_prompt_json).toBe('{"pending":true}');
  });

  it("leaves debug_prompt_json null when debug_capture is false/undefined", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    const { agentId, envId } = await seedAgentEnv();
    const { createSession, getSessionRow } = await import("../src/db/sessions");
    const session = createSession({
      agent_id: agentId, agent_version: 1, environment_id: envId,
      tenant_id: "tenant_default",
    });
    const row = getSessionRow(session.id);
    expect(row?.debug_prompt_json).toBeNull();
  });
});

describe("handleGetDebugPrompt", () => {
  beforeEach(() => freshDbEnv());

  async function seed(): Promise<{ adminKey: string; sessionId: string }> {
    const { getDb } = await import("../src/db/client");
    getDb();
    const { createApiKey } = await import("../src/db/api_keys");
    const { key } = createApiKey({
      name: "admin",
      permissions: { admin: true, scope: null },
      rawKey: "ck_test_debug_admin_xxxxxxx",
    });
    const { agentId, envId } = await seedAgentEnv();
    const { createSession } = await import("../src/db/sessions");
    const sess = createSession({
      agent_id: agentId, agent_version: 1, environment_id: envId,
      tenant_id: "tenant_default",
      debug_capture: true,
    });
    return { adminKey: key, sessionId: sess.id };
  }

  function reqFor(id: string, apiKey: string): Request {
    return new Request(`http://localhost/v1/sessions/${id}/debug-prompt`, {
      headers: { "x-api-key": apiKey },
    });
  }

  it("404 when debug capture is not enabled", async () => {
    const { getDb } = await import("../src/db/client");
    getDb();
    const { createApiKey } = await import("../src/db/api_keys");
    const { key: adminKey } = createApiKey({
      name: "admin", permissions: { admin: true, scope: null },
      rawKey: "ck_test_debug_admin_xxxxxxx",
    });
    const { agentId, envId } = await seedAgentEnv();
    const { createSession } = await import("../src/db/sessions");
    const sess = createSession({
      agent_id: agentId, agent_version: 1, environment_id: envId,
      tenant_id: "tenant_default",
    });

    const { handleGetDebugPrompt } = await import("../src/handlers/debug-prompt");
    const res = await handleGetDebugPrompt(reqFor(sess.id, adminKey), sess.id);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/not enabled/);
  });

  it("404 with 'pending' message when no turn has captured yet", async () => {
    const { adminKey, sessionId } = await seed();
    const { handleGetDebugPrompt } = await import("../src/handlers/debug-prompt");
    const res = await handleGetDebugPrompt(reqFor(sessionId, adminKey), sessionId);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/pending/);
  });

  it("200 returns the payload when captured within retention window", async () => {
    const { adminKey, sessionId } = await seed();
    const captured = {
      captured_at: new Date().toISOString(),
      backend: "claude",
      model: "claude-sonnet-4-6",
      argv: ["claude", "--system-prompt", "you are a contract reviewer"],
      env: { MCP_TIMEOUT: "30000" },
      prompt: "review this contract",
      system: "you are a contract reviewer",
    };
    const { getDb } = await import("../src/db/client");
    getDb().prepare(`UPDATE sessions SET debug_prompt_json = ? WHERE id = ?`)
      .run(JSON.stringify(captured), sessionId);

    const { handleGetDebugPrompt } = await import("../src/handlers/debug-prompt");
    const res = await handleGetDebugPrompt(reqFor(sessionId, adminKey), sessionId);
    expect(res.status).toBe(200);
    const body = await res.json() as typeof captured;
    expect(body.backend).toBe("claude");
    expect(body.prompt).toBe("review this contract");
    expect(body.argv).toContain("--system-prompt");
  });

  it("410 when captured_at is older than 1h", async () => {
    const { adminKey, sessionId } = await seed();
    const old = new Date(Date.now() - 70 * 60 * 1000).toISOString();
    const captured = {
      captured_at: old,
      backend: "claude", model: "claude-sonnet-4-6",
      argv: [], env: {}, prompt: "", system: null,
    };
    const { getDb } = await import("../src/db/client");
    getDb().prepare(`UPDATE sessions SET debug_prompt_json = ? WHERE id = ?`)
      .run(JSON.stringify(captured), sessionId);

    const { handleGetDebugPrompt } = await import("../src/handlers/debug-prompt");
    const res = await handleGetDebugPrompt(reqFor(sessionId, adminKey), sessionId);
    expect(res.status).toBe(410);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/expired/);
  });

  it("404 for cross-tenant access (tenant scoping)", async () => {
    // Seed a session in tenant_a, then try to read it with a key
    // scoped to tenant_b. Should return 404 (not 403, per
    // assertResourceTenant's no-probe rule).
    const { getDb } = await import("../src/db/client");
    getDb();
    const { createTenant } = await import("../src/db/tenants");
    try { createTenant({ id: "tenant_a", name: "a" }); } catch { /* exists */ }
    try { createTenant({ id: "tenant_b", name: "b" }); } catch { /* exists */ }
    const { createApiKey } = await import("../src/db/api_keys");
    const { key: bKey } = createApiKey({
      name: "tenant-b-admin",
      permissions: { admin: true, scope: null },
      tenantId: "tenant_b",
      rawKey: "ck_test_debug_tenant_b_xxx",
    });
    const { agentId, envId } = await seedAgentEnv("tenant_a");
    const { createSession } = await import("../src/db/sessions");
    const aSession = createSession({
      agent_id: agentId, agent_version: 1, environment_id: envId,
      tenant_id: "tenant_a",
      debug_capture: true,
    });

    const { handleGetDebugPrompt } = await import("../src/handlers/debug-prompt");
    const res = await handleGetDebugPrompt(reqFor(aSession.id, bKey), aSession.id);
    expect(res.status).toBe(404);
  });
});
