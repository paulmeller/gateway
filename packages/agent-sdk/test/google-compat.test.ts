// @ts-nocheck — test file with loose typing on handler responses
/**
 * Integration test for Google Interactions API compatibility layer.
 * Verifies that POST /google/v1beta/interactions works end-to-end
 * by creating an agent and running an interaction against a mock backend.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Hoisted mocks — must be at module top.
vi.mock("../src/containers/exec", async () => {
  const fake = await import("./helpers/fake-exec");
  return { startExec: fake.startExec };
});

vi.mock("../src/containers/lifecycle", () => ({
  acquireForFirstTurn: vi.fn(async () => "ca-sess-fake"),
  releaseSession: vi.fn(async () => {}),
  reconcileOrphanSandboxes: vi.fn(async () => ({ deleted: 0, kept: 0 })),
  reconcileDockerOrphanSandboxes: vi.fn(async () => ({ deleted: 0, kept: 0 })),
  fillWarmPools: vi.fn(async () => {}),
  installSkills: vi.fn(async () => {}),
  provisionResources: vi.fn(async () => {}),
  wrapProviderWithSecrets: vi.fn(async (p: unknown) => p),
}));

vi.mock("../src/providers/registry", async () => {
  const fake = await import("./helpers/fake-exec");
  const fakeProvider = {
    name: "sprites",
    stripControlChars: true,
    startExec: fake.startExec,
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exit_code: 0 })),
    create: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => []),
  };
  return {
    resolveContainerProvider: async () => fakeProvider,
    resolveProvider: async () => fakeProvider,
    tryResolveProvider: async () => fakeProvider,
    resolveProviderName: (opts?: { override?: string; envConfigProvider?: string | null }) =>
      opts?.override ?? opts?.envConfigProvider ?? "sprites",
  };
});

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "google-compat-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  process.env.GEMINI_API_KEY = "fake-gemini-key";
  const g = globalThis as any;
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  delete g.__caActors;
  delete g.__caLicense;
  delete g.__caQueue;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle);
    delete g.__caSweeperHandle;
  }
}

async function bootDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb(); // triggers migrations
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-12345" });
  return key;
}

function req(url: string, opts: { method?: string; body?: unknown; apiKey?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey !== undefined) {
    headers["x-api-key"] = opts.apiKey;
  } else {
    headers["x-api-key"] = "test-api-key-12345";
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

/** Create a ready environment directly in the DB (avoids async provider setup). */
async function createReadyEnv(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  const { newId } = await import("../src/util/ids");
  const { nowMs } = await import("../src/util/clock");
  const db = getDb();
  const id = newId("env");
  const now = nowMs();
  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at, updated_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?, ?)`
  ).run(id, "test-env", JSON.stringify({ type: "self_hosted", provider: "docker" }), now, now);
  return id;
}

describe("Google Interactions API compatibility", () => {
  beforeEach(() => {
    freshDbEnv();
    vi.clearAllMocks();
  });

  it("POST /google/v1beta/interactions creates session and returns interaction", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    // Enqueue a scripted gemini turn: init + message + result
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_sess_1","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"Hello! How can I help you?"}',
        '{"type":"result","stats":{"input_tokens":10,"output_tokens":8,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");

    const res = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: {
        model: "gemini-2.5-flash",
        input: "Hello, world!",
      },
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.id).toMatch(/^int_/);
    expect(body.status).toBe("completed");
    expect(body.steps).toBeDefined();
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.usage).toBeDefined();
    expect(typeof body.usage.total_input_tokens).toBe("number");
    expect(typeof body.usage.total_output_tokens).toBe("number");
    expect(typeof body.usage.total_tokens).toBe("number");
    expect(body.usage.total_input_tokens).toBe(10);
    expect(body.usage.total_output_tokens).toBe(8);
    expect(body.usage.total_tokens).toBe(18);
    // Should have a model output step with the assistant text
    const textStep = body.steps.find((s: any) => s.type === "model_output");
    expect(textStep).toBeDefined();
    expect(textStep.content[0].text).toBe("Hello! How can I help you?");
  });

  it("rejects request with neither model nor agent", async () => {
    await bootDb();

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");

    const res = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { input: "Hello" },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("either 'model' or 'agent' is required");
  });

  it("rejects request with invalid body", async () => {
    await bootDb();

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");

    const res = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash" },
    }));
    expect(res.status).toBe(400);
  });

  it("accepts x-goog-api-key header for auth", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_sess_2","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"hi"}',
        '{"type":"result","stats":{"input_tokens":5,"output_tokens":2,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");

    // Use x-goog-api-key instead of x-api-key (simulating what the Hono middleware does)
    const request = new Request("http://localhost/google/v1beta/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-api-key-12345",
      },
      body: JSON.stringify({ model: "gemini-2.5-flash", input: "test" }),
    });

    const res = await handleCreateInteraction(request);
    // Should authenticate successfully (not 401)
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it("GET /google/v1beta/interactions/:id returns stored interaction", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_get_1","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"Got it!"}',
        '{"type":"result","stats":{"input_tokens":12,"output_tokens":4,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction, handleGetInteraction } = await import("../src/handlers/google-compat");

    const createRes = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash", input: "Tell me something" },
    }));
    expect(createRes.status).toBe(200);
    const created = await createRes.json();

    // Now GET the interaction by ID
    const getRes = await handleGetInteraction(req(`/google/v1beta/interactions/${created.id}`, { method: "GET" }), created.id);
    expect(getRes.status).toBe(200);
    const got = await getRes.json();
    expect(got.id).toBe(created.id);
    expect(got.status).toBe("completed");
    expect(got.steps).toBeDefined();
    expect(Array.isArray(got.steps)).toBe(true);
    expect(got.usage).toBeDefined();
  });

  it("GET /google/v1beta/interactions/:id returns 404 for unknown", async () => {
    await bootDb();

    const { handleGetInteraction } = await import("../src/handlers/google-compat");

    const res = await handleGetInteraction(req("/google/v1beta/interactions/int_nonexistent", { method: "GET" }), "int_nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /google/v1beta/interactions/:id removes it", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_del_1","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"Deleted soon"}',
        '{"type":"result","stats":{"input_tokens":5,"output_tokens":2,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction, handleGetInteraction, handleDeleteInteraction } = await import("../src/handlers/google-compat");

    const createRes = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash", input: "Delete me" },
    }));
    expect(createRes.status).toBe(200);
    const created = await createRes.json();

    // Delete
    const delRes = await handleDeleteInteraction(req(`/google/v1beta/interactions/${created.id}`, { method: "DELETE" }), created.id);
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.id).toBe(created.id);
    expect(delBody.deleted).toBe(true);

    // Verify 404 on second GET
    const getRes = await handleGetInteraction(req(`/google/v1beta/interactions/${created.id}`, { method: "GET" }), created.id);
    expect(getRes.status).toBe(404);
  });

  it("POST /google/v1beta/agents creates agent with base_agent and sources", async () => {
    await bootDb();

    const { handleCreateGoogleAgent } = await import("../src/handlers/google-compat");

    const res = await handleCreateGoogleAgent(req("/google/v1beta/agents", {
      body: {
        id: "my-test-agent",
        description: "A test agent",
        base_agent: "antigravity-preview-05-2026",
        system_instruction: "You are helpful.",
        base_environment: {
          type: "container",
          sources: [
            { target: ".agents/AGENTS.md", content: "Extra instructions here." },
            { target: ".agents/skills/my-skill/SKILL.md", content: "# My Skill\nDo something." },
          ],
        },
      },
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("my-test-agent");
    expect(body.base_agent).toBe("antigravity-preview-05-2026");
    expect(body.description).toBe("A test agent");
    // system_instruction should include both the explicit one and the AGENTS.md content
    expect(body.system_instruction).toContain("You are helpful.");
    expect(body.system_instruction).toContain("Extra instructions here.");
  });

  it("GET /google/v1beta/agents lists agents in Google format", async () => {
    await bootDb();

    const { handleCreateGoogleAgent, handleListGoogleAgents } = await import("../src/handlers/google-compat");

    // Create an agent first
    await handleCreateGoogleAgent(req("/google/v1beta/agents", {
      body: {
        id: "list-test-agent",
        base_agent: "antigravity-preview-05-2026",
        description: "For listing",
      },
    }));

    const listRes = await handleListGoogleAgents(req("/google/v1beta/agents", { method: "GET" }));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.agents).toBeDefined();
    expect(Array.isArray(listBody.agents)).toBe(true);
    const found = listBody.agents.find((a: any) => a.id === "list-test-agent");
    expect(found).toBeDefined();
    expect(found.base_agent).toBe("antigravity-preview-05-2026");
  });

  it("GET /google/v1beta/agents/:id returns single agent", async () => {
    await bootDb();

    const { handleCreateGoogleAgent, handleGetGoogleAgent } = await import("../src/handlers/google-compat");

    await handleCreateGoogleAgent(req("/google/v1beta/agents", {
      body: {
        id: "get-test-agent",
        base_agent: "antigravity-preview-05-2026",
        description: "For getting",
      },
    }));

    const getRes = await handleGetGoogleAgent(req("/google/v1beta/agents/get-test-agent", { method: "GET" }), "get-test-agent");
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.id).toBe("get-test-agent");
    expect(body.base_agent).toBe("antigravity-preview-05-2026");
    expect(body.description).toBe("For getting");
  });

  it("GET /google/v1beta/agents/:id returns 404 for unknown", async () => {
    await bootDb();

    const { handleGetGoogleAgent } = await import("../src/handlers/google-compat");

    const res = await handleGetGoogleAgent(req("/google/v1beta/agents/nonexistent", { method: "GET" }), "nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /google/v1beta/agents/:id removes agent", async () => {
    await bootDb();

    const { handleCreateGoogleAgent, handleGetGoogleAgent, handleDeleteGoogleAgent } = await import("../src/handlers/google-compat");

    await handleCreateGoogleAgent(req("/google/v1beta/agents", {
      body: {
        id: "delete-test-agent",
        base_agent: "antigravity-preview-05-2026",
      },
    }));

    const delRes = await handleDeleteGoogleAgent(req("/google/v1beta/agents/delete-test-agent", { method: "DELETE" }), "delete-test-agent");
    expect(delRes.status).toBe(200);

    // Verify it's gone
    const getRes = await handleGetGoogleAgent(req("/google/v1beta/agents/delete-test-agent", { method: "GET" }), "delete-test-agent");
    expect(getRes.status).toBe(404);
  });

  it("handles function_result input for tool call responses", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    // First turn: normal completion
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_fn_1","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"Let me check."}',
        '{"type":"result","stats":{"input_tokens":10,"output_tokens":5,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    // Second turn: after function_result is provided as re-entry
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_fn_1","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"The weather in London is sunny."}',
        '{"type":"result","stats":{"input_tokens":15,"output_tokens":8,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");

    // First call creates the session
    const res1 = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash", input: "What's the weather in London?" },
    }));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    const interactionId = body1.id;

    // Second call with function_result input (tests parsing doesn't crash)
    const res2 = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: {
        model: "gemini-2.5-flash",
        previous_interaction_id: interactionId,
        input: [
          { type: "function_result", call_id: "call_123", result: "Sunny, 22C" },
        ],
      },
    }));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    // Should not crash and should produce a completed interaction
    expect(body2.id).toBeDefined();
    expect(body2.status).toBe("completed");
  });

  it("GET /google/v1beta/files/environment-:id:download returns tar archive", async () => {
    await bootDb();
    const envId = await createReadyEnv();

    const { handleGetEnvironmentFiles } = await import("../src/handlers/google-compat");

    // Request file download for this environment (no files exist yet — should return empty tar)
    const res = await handleGetEnvironmentFiles(
      req(`/google/v1beta/files/environment-${envId}:download`, { method: "GET" }),
      `environment-${envId}:download`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    const buf = await res.arrayBuffer();
    // Empty tar is 1024 bytes (two zero blocks)
    expect(buf.byteLength).toBe(1024);
  });

  it("GET /google/v1beta/files/environment-:id:download returns 404 for unknown env", async () => {
    await bootDb();

    const { handleGetEnvironmentFiles } = await import("../src/handlers/google-compat");

    const res = await handleGetEnvironmentFiles(
      req("/google/v1beta/files/environment-env_nonexistent:download", { method: "GET" }),
      "environment-env_nonexistent:download",
    );
    expect(res.status).toBe(404);
  });

  it("GET /google/v1beta/files/environment-:id:download includes uploaded files in tar", async () => {
    await bootDb();
    const envId = await createReadyEnv();

    // Create agent + version + session in the environment
    const { getDb } = await import("../src/db/client");
    const { newId } = await import("../src/util/ids");
    const { nowMs } = await import("../src/util/clock");
    const { createFile, updateFileStoragePath } = await import("../src/db/files");
    const { storeFile } = await import("../src/files/storage");

    const db = getDb();
    const now = nowMs();
    const agentId = newId("ag");
    db.prepare(
      `INSERT INTO agents (id, current_version, name, created_at, updated_at) VALUES (?, 1, ?, ?, ?)`
    ).run(agentId, "tar-test-agent", now, now);
    db.prepare(
      `INSERT INTO agent_versions (agent_id, version, model, system, tools_json, mcp_servers_json, created_at) VALUES (?, 1, ?, ?, ?, ?, ?)`
    ).run(agentId, "test-model", null, "[]", "{}", now);

    const sessionId = newId("sess");
    db.prepare(
      `INSERT INTO sessions (id, agent_id, agent_version, environment_id, status, metadata_json, created_at, updated_at) VALUES (?, ?, 1, ?, 'idle', '{}', ?, ?)`
    ).run(sessionId, agentId, envId, now, now);

    // Upload a file scoped to this session
    const fileData = Buffer.from("Hello from tar test!");
    const record = createFile({
      filename: "output.txt",
      size: fileData.length,
      content_type: "text/plain",
      storage_path: "",
      scope: { type: "session", id: sessionId },
    });
    const storagePath = storeFile(record.id, "output.txt", fileData);
    updateFileStoragePath(record.id, storagePath);

    const { handleGetEnvironmentFiles } = await import("../src/handlers/google-compat");

    const res = await handleGetEnvironmentFiles(
      req(`/google/v1beta/files/environment-${envId}:download`, { method: "GET" }),
      `environment-${envId}:download`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    const buf = Buffer.from(await res.arrayBuffer());
    // Tar should be larger than empty (1024 bytes = just end blocks)
    expect(buf.byteLength).toBeGreaterThan(1024);
    // The filename should appear in the tar header
    expect(buf.toString("utf8", 0, 10)).toBe("output.txt");
  });

  it("POST /google/v1beta/interactions/:id/cancel updates status to cancelled", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_cancel_1","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"Working on it..."}',
        '{"type":"result","stats":{"input_tokens":8,"output_tokens":4,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction, handleCancelInteraction } = await import("../src/handlers/google-compat");

    // Create an interaction first
    const createRes = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash", input: "Do something long" },
    }));
    expect(createRes.status).toBe(200);
    const created = await createRes.json();
    expect(created.id).toMatch(/^int_/);

    // Cancel it
    const cancelRes = await handleCancelInteraction(req(`/google/v1beta/interactions/${created.id}/cancel`, { method: "POST" }), created.id);
    expect(cancelRes.status).toBe(200);
    const cancelBody = await cancelRes.json();
    expect(cancelBody.id).toBe(created.id);
    expect(cancelBody.status).toBe("cancelled");
  });

  it("returns 404 when previous_interaction_id is invalid", async () => {
    await bootDb();
    await createReadyEnv();

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");

    const res = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: {
        model: "gemini-2.5-flash",
        input: "Follow up message",
        previous_interaction_id: "int_nonexistent_12345",
      },
    }));
    expect(res.status).toBe(404);
  });

  it("passes system_instruction to agent creation", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_sys_1","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"I am a pirate!"}',
        '{"type":"result","stats":{"input_tokens":10,"output_tokens":5,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");
    const { handleListAgents } = await import("../src/handlers/anthropic-compat/agents");

    // Create interaction with system_instruction
    const res = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: {
        model: "gemini-2.5-flash",
        input: "Say hello",
        system_instruction: "You are a pirate. Always talk like one.",
      },
    }));
    expect(res.status).toBe(200);

    // Check the auto-created agent has the system prompt set
    const listRes = await handleListAgents(req("/anthropic/v1/agents?limit=100"));
    const listBody = await listRes.json();
    const agent = listBody.data.find((a: any) => a.system === "You are a pirate. Always talk like one.");
    expect(agent).toBeDefined();
    expect(agent.system).toBe("You are a pirate. Always talk like one.");
  });

  it("maps antigravity-preview-05-2026 to gemini engine", async () => {
    await bootDb();

    const { handleCreateGoogleAgent } = await import("../src/handlers/google-compat");
    const { handleListAgents } = await import("../src/handlers/anthropic-compat/agents");

    // Create a Google agent with base_agent
    const res = await handleCreateGoogleAgent(req("/google/v1beta/agents", {
      body: {
        id: "engine-test-agent",
        base_agent: "antigravity-preview-05-2026",
      },
    }));
    expect(res.status).toBe(201);

    // Verify the internal agent has engine "gemini"
    const listRes = await handleListAgents(req("/anthropic/v1/agents?limit=100"));
    const listBody = await listRes.json();
    const agent = listBody.data.find((a: any) => a.name === "engine-test-agent");
    expect(agent).toBeDefined();
    expect(agent.engine).toBe("gemini");
  });

  it("extracts skills from .agents/skills/*/SKILL.md sources", async () => {
    await bootDb();

    const { handleCreateGoogleAgent } = await import("../src/handlers/google-compat");
    const { handleListAgents } = await import("../src/handlers/anthropic-compat/agents");

    const res = await handleCreateGoogleAgent(req("/google/v1beta/agents", {
      body: {
        id: "skills-test-agent",
        base_agent: "antigravity-preview-05-2026",
        base_environment: {
          type: "container",
          sources: [
            { target: ".agents/skills/weather/SKILL.md", content: "# Weather Skill\nGet weather data." },
            { target: ".agents/skills/calendar/SKILL.md", content: "# Calendar Skill\nManage events." },
          ],
        },
      },
    }));
    expect(res.status).toBe(201);

    // Verify the internal agent has skills attached
    const listRes = await handleListAgents(req("/anthropic/v1/agents?limit=100"));
    const listBody = await listRes.json();
    const agent = listBody.data.find((a: any) => a.name === "skills-test-agent");
    expect(agent).toBeDefined();
    expect(agent.skills).toBeDefined();
    expect(Array.isArray(agent.skills)).toBe(true);
    expect(agent.skills.length).toBe(2);
    const skillNames = agent.skills.map((s: any) => s.name);
    expect(skillNames).toContain("weather");
    expect(skillNames).toContain("calendar");
  });

  it("multi-turn with previous_interaction_id sends message to same session", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    // First turn
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_multi_1","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"First response."}',
        '{"type":"result","stats":{"input_tokens":5,"output_tokens":3,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    // Second turn (same session)
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_multi_1","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"Second response."}',
        '{"type":"result","stats":{"input_tokens":10,"output_tokens":3,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");

    // First interaction creates the session
    const res1 = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash", input: "Hello" },
    }));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    const firstId = body1.id;

    // Second interaction with previous_interaction_id
    const res2 = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: {
        model: "gemini-2.5-flash",
        input: "Follow up",
        previous_interaction_id: firstId,
      },
    }));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.id).toBeDefined();
    expect(body2.id).not.toBe(firstId);
    expect(body2.status).toBe("completed");

    // Verify both interactions share the same session and seq is incremented
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, session_id, seq FROM google_interactions ORDER BY seq ASC`
    ).all() as Array<{ id: string; session_id: string; seq: number }>;
    expect(rows.length).toBe(2);
    expect(rows[0].session_id).toBe(rows[1].session_id);
    expect(rows[0].seq).toBe(1);
    expect(rows[1].seq).toBe(2);
  });

  it("POST /google/v1beta/interactions/:id/cancel returns 404 for unknown", async () => {
    await bootDb();

    const { handleCancelInteraction } = await import("../src/handlers/google-compat");

    const res = await handleCancelInteraction(
      req("/google/v1beta/interactions/int_nonexistent/cancel", { method: "POST" }),
      "int_nonexistent",
    );
    expect(res.status).toBe(404);
  });

  it("reuses existing agent with same name on second call", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();

    // Two turns queued for two interactions
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_sess_3a","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"first"}',
        '{"type":"result","stats":{"input_tokens":5,"output_tokens":1,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"gemini_sess_3b","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"second"}',
        '{"type":"result","stats":{"input_tokens":5,"output_tokens":1,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    const { handleCreateInteraction } = await import("../src/handlers/google-compat");
    const { handleListAgents } = await import("../src/handlers/anthropic-compat/agents");

    // First interaction creates the agent
    const res1 = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash", input: "hello" },
    }));
    expect(res1.status).toBe(200);

    // Check agent count
    const listRes1 = await handleListAgents(req("/anthropic/v1/agents?limit=100"));
    const list1 = await listRes1.json();
    const agentCount1 = list1.data.length;

    // Second interaction should reuse the same agent
    const res2 = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash", input: "world" },
    }));
    expect(res2.status).toBe(200);

    const listRes2 = await handleListAgents(req("/anthropic/v1/agents?limit=100"));
    const list2 = await listRes2.json();
    expect(list2.data.length).toBe(agentCount1); // No new agent created
  });

  it("reuses existing agent by model match and attaches its vaults", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"vault_test_1","model":"claude-sonnet-4-6"}',
        '{"type":"message","role":"assistant","content":"hi"}',
        '{"type":"result","stats":{"input_tokens":5,"output_tokens":1,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    // Create an agent with a specific model via the normal API
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");
    const agentRes = await handleCreateAgent(req("/anthropic/v1/agents", {
      body: { name: "my-claude-agent", model: { id: "claude-sonnet-4-6" } },
    }));
    expect(agentRes.status).toBe(201);
    const agent = await agentRes.json();

    // Create a vault scoped to this agent
    const { createVault } = await import("../src/db/vaults");
    const { seedDefaultTenant } = await import("../src/db/tenants");
    seedDefaultTenant();
    const vault = createVault({ agent_id: agent.id, name: "test-vault", tenant_id: "tenant_default" });

    // Now call Google compat with the same model — should find the existing agent
    const { handleCreateInteraction } = await import("../src/handlers/google-compat");
    const res = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "claude-sonnet-4-6", input: "Hello" },
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    // Should not have created a new agent — reused the existing one
    const { handleListAgents } = await import("../src/handlers/anthropic-compat/agents");
    const listRes = await handleListAgents(req("/anthropic/v1/agents?limit=100"));
    const agents = (await listRes.json()).data;
    const claudeAgents = agents.filter((a: any) => a.model?.id === "claude-sonnet-4-6");
    expect(claudeAgents.length).toBe(1); // Only the original, no auto-created duplicate
    expect(claudeAgents[0].id).toBe(agent.id);
  });

  it("only attaches unscoped vaults when agent has none", async () => {
    await bootDb();
    await createReadyEnv();

    const fake = await import("./helpers/fake-exec");
    fake.resetQueue();
    fake.enqueueTurn({
      ndjson: [
        '{"type":"init","session_id":"vault_test_2","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"hi"}',
        '{"type":"result","stats":{"input_tokens":5,"output_tokens":1,"cost_usd":0.0001,"num_turns":1}}',
      ],
    });

    // Create a vault scoped to a DIFFERENT agent
    const { createVault } = await import("../src/db/vaults");
    const { seedDefaultTenant } = await import("../src/db/tenants");
    seedDefaultTenant();
    createVault({ agent_id: "agent_other_123", name: "other-vault", tenant_id: "tenant_default" });

    // Create an unscoped vault (no agent_id)
    const unscopedVault = createVault({ name: "shared-vault", tenant_id: "tenant_default" });

    // Google compat creates a new agent — should only attach the unscoped vault, not the other agent's
    const { handleCreateInteraction } = await import("../src/handlers/google-compat");
    const res = await handleCreateInteraction(req("/google/v1beta/interactions", {
      body: { model: "gemini-2.5-flash", input: "test" },
    }));

    // Should succeed (not fail with "vault belongs to a different agent")
    expect(res.status).toBe(200);
  });
});
