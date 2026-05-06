// @ts-nocheck — test file with loose typing on handler responses
/**
 * Spec-alignment tests.
 *
 * Validates that our API response shapes match the Anthropic Managed Agents
 * OpenAPI spec (docs/superpowers/specs/anthropic-openapi.yml).
 *
 * Checks required fields, type discriminators, nested object shapes,
 * and list pagination format for agents, sessions, environments, and vaults.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure (mirrors api-comprehensive.test.ts)
// ---------------------------------------------------------------------------

/** Wipe all globalThis singletons so next import gets a fresh DB. */
function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-spec-align-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
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
}

/** Boot DB + seed a default API key, return the raw key string for auth. */
async function bootDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb(); // triggers migrations
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-12345" });
  return key;
}

/** Build a Request with JSON body + auth header. */
function req(
  url: string,
  opts: { method?: string; body?: unknown; apiKey?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.apiKey !== undefined) {
    if (opts.apiKey !== "") headers["x-api-key"] = opts.apiKey;
  } else {
    headers["x-api-key"] = "test-api-key-12345";
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/** Create a ready environment directly in DB (avoids provider checks). */
async function createReadyEnv(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { getDb } = await import("../src/db/client");
  const { newId } = await import("../src/util/ids");
  const { nowMs, toIso } = await import("../src/util/clock");

  const db = getDb();
  const id = newId("env");
  const now = nowMs();
  const name = overrides.name as string ?? `env-${Date.now()}-${Math.random()}`;
  const config = overrides.config ?? { type: "cloud", provider: "docker" };

  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at, updated_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?, ?)`,
  ).run(id, name, JSON.stringify(config), now, now);

  return { id, name, config, state: "ready", created_at: toIso(now) };
}

// ---------------------------------------------------------------------------
// Anthropic OpenAPI spec — required fields per schema
// ---------------------------------------------------------------------------

const AGENT_REQUIRED_FIELDS = [
  "type", "id", "version", "name", "description", "model",
  "system", "tools", "mcp_servers", "skills", "metadata",
  "created_at", "updated_at", "archived_at",
];

const SESSION_REQUIRED_FIELDS = [
  "type", "id", "status", "created_at", "updated_at",
  "environment_id", "title", "metadata", "agent",
  "resources", "vault_ids", "usage", "stats", "archived_at",
];

const SESSION_AGENT_REQUIRED_FIELDS = [
  "type", "id", "version", "name", "description", "model",
  "system", "tools", "mcp_servers", "skills",
];

const VAULT_REQUIRED_FIELDS = [
  "type", "id", "display_name", "metadata",
  "created_at", "updated_at", "archived_at",
];

const ENVIRONMENT_REQUIRED_FIELDS = [
  "type", "id", "name", "description", "config", "metadata",
  "created_at", "updated_at", "archived_at",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Anthropic API spec alignment", () => {
  beforeEach(() => freshDbEnv());

  // =========================================================================
  // Agent
  // =========================================================================
  describe("Agent response shape", () => {
    it("has all Anthropic-required fields", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const res = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "spec-test-agent", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();

      for (const field of AGENT_REQUIRED_FIELDS) {
        expect(body, `Agent missing required field: ${field}`).toHaveProperty(field);
      }
    });

    it("type field is 'agent'", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const res = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "type-test", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const body = await res.json();
      expect(body.type).toBe("agent");
    });

    it("model is an object with id field", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const res = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "model-test", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const body = await res.json();
      expect(typeof body.model).toBe("object");
      expect(body.model).not.toBeNull();
      expect(body.model).toHaveProperty("id");
      expect(body.model.id).toBe("claude-sonnet-4-6");
    });

    it("mcp_servers is an array", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const res = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "mcp-test", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const body = await res.json();
      expect(Array.isArray(body.mcp_servers)).toBe(true);
    });

    it("tools is an array", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const res = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "tools-test", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const body = await res.json();
      expect(Array.isArray(body.tools)).toBe(true);
    });

    it("skills is an array", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const res = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "skills-test", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const body = await res.json();
      expect(Array.isArray(body.skills)).toBe(true);
    });

    it("metadata is an object", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const res = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "meta-test", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const body = await res.json();
      expect(typeof body.metadata).toBe("object");
      expect(body.metadata).not.toBeNull();
    });

    it("version is an integer", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const res = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "version-test", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const body = await res.json();
      expect(typeof body.version).toBe("number");
      expect(Number.isInteger(body.version)).toBe(true);
      expect(body.version).toBeGreaterThanOrEqual(1);
    });

    it("timestamps are ISO 8601 strings or null", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const res = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "ts-test", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const body = await res.json();
      expect(typeof body.created_at).toBe("string");
      expect(typeof body.updated_at).toBe("string");
      // archived_at should be null for a freshly created agent
      expect(body.archived_at).toBeNull();
      // Verify ISO format
      expect(new Date(body.created_at).toISOString()).toBeTruthy();
      expect(new Date(body.updated_at).toISOString()).toBeTruthy();
    });
  });

  // =========================================================================
  // Session
  // =========================================================================
  describe("Session response shape", () => {
    it("has all Anthropic-required fields", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "session-agent", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const agent = await agentRes.json();
      const env = await createReadyEnv({ name: "session-env" });

      const { handleCreateSession } = await import("../src/handlers/sessions");
      const res = await handleCreateSession(
        req("/v1/sessions", {
          body: { agent: agent.id, environment_id: env.id },
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();

      for (const field of SESSION_REQUIRED_FIELDS) {
        expect(body, `Session missing required field: ${field}`).toHaveProperty(field);
      }
    });

    it("type field is 'session'", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "session-type-agent", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const agent = await agentRes.json();
      const env = await createReadyEnv({ name: "session-type-env" });

      const { handleCreateSession } = await import("../src/handlers/sessions");
      const res = await handleCreateSession(
        req("/v1/sessions", {
          body: { agent: agent.id, environment_id: env.id },
        }),
      );
      const body = await res.json();
      expect(body.type).toBe("session");
    });

    it("embedded agent has all required fields", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "embed-agent", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const agent = await agentRes.json();
      const env = await createReadyEnv({ name: "embed-env" });

      const { handleCreateSession } = await import("../src/handlers/sessions");
      const res = await handleCreateSession(
        req("/v1/sessions", {
          body: { agent: agent.id, environment_id: env.id },
        }),
      );
      const body = await res.json();

      for (const field of SESSION_AGENT_REQUIRED_FIELDS) {
        expect(body.agent, `Session.agent missing required field: ${field}`).toHaveProperty(field);
      }
      expect(body.agent.type).toBe("agent");
      expect(typeof body.agent.model).toBe("object");
      expect(body.agent.model).toHaveProperty("id");
      expect(Array.isArray(body.agent.tools)).toBe(true);
      expect(Array.isArray(body.agent.mcp_servers)).toBe(true);
      expect(Array.isArray(body.agent.skills)).toBe(true);
    });

    it("usage has cache_creation as nested object (not flat)", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "usage-agent", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const agent = await agentRes.json();
      const env = await createReadyEnv({ name: "usage-env" });

      const { handleCreateSession } = await import("../src/handlers/sessions");
      const res = await handleCreateSession(
        req("/v1/sessions", {
          body: { agent: agent.id, environment_id: env.id },
        }),
      );
      const body = await res.json();

      expect(body.usage).toBeDefined();
      expect(typeof body.usage).toBe("object");
      expect(body.usage).toHaveProperty("input_tokens");
      expect(body.usage).toHaveProperty("output_tokens");
      expect(body.usage).toHaveProperty("cache_read_input_tokens");
      // Anthropic spec: cache_creation is a nested object, NOT flat cache_creation_input_tokens
      expect(body.usage).toHaveProperty("cache_creation");
      expect(typeof body.usage.cache_creation).toBe("object");
      expect(body.usage).not.toHaveProperty("cache_creation_input_tokens");
    });

    it("stats has duration_seconds and active_seconds", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "stats-agent", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const agent = await agentRes.json();
      const env = await createReadyEnv({ name: "stats-env" });

      const { handleCreateSession } = await import("../src/handlers/sessions");
      const res = await handleCreateSession(
        req("/v1/sessions", {
          body: { agent: agent.id, environment_id: env.id },
        }),
      );
      const body = await res.json();

      expect(body.stats).toBeDefined();
      expect(typeof body.stats).toBe("object");
      expect(body.stats).toHaveProperty("duration_seconds");
      expect(body.stats).toHaveProperty("active_seconds");
    });

    it("vault_ids is an array", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "vault-agent", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const agent = await agentRes.json();
      const env = await createReadyEnv({ name: "vault-env" });

      const { handleCreateSession } = await import("../src/handlers/sessions");
      const res = await handleCreateSession(
        req("/v1/sessions", {
          body: { agent: agent.id, environment_id: env.id },
        }),
      );
      const body = await res.json();
      expect(Array.isArray(body.vault_ids)).toBe(true);
    });

    it("resources is an array", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "res-agent", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const agent = await agentRes.json();
      const env = await createReadyEnv({ name: "res-env" });

      const { handleCreateSession } = await import("../src/handlers/sessions");
      const res = await handleCreateSession(
        req("/v1/sessions", {
          body: { agent: agent.id, environment_id: env.id },
        }),
      );
      const body = await res.json();
      expect(Array.isArray(body.resources)).toBe(true);
    });
  });

  // =========================================================================
  // Vault
  // =========================================================================
  describe("Vault response shape", () => {
    it("has all Anthropic-required fields", async () => {
      await bootDb();
      // Vaults require an agent_id
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "vault-spec-agent", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const agent = await agentRes.json();

      const { handleCreateVault } = await import("../src/handlers/vaults");
      const res = await handleCreateVault(
        req("/v1/vaults", {
          body: { display_name: "spec-test-vault", agent_id: agent.id },
        }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();

      for (const field of VAULT_REQUIRED_FIELDS) {
        expect(body, `Vault missing required field: ${field}`).toHaveProperty(field);
      }
    });

    it("type field is 'vault'", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "vault-type-agent", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const agent = await agentRes.json();

      const { handleCreateVault } = await import("../src/handlers/vaults");
      const res = await handleCreateVault(
        req("/v1/vaults", {
          body: { display_name: "type-vault", agent_id: agent.id },
        }),
      );
      const body = await res.json();
      expect(body.type).toBe("vault");
    });

    it("metadata is an object", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", {
          body: { name: "vault-meta-agent", model: { id: "claude-sonnet-4-6" } },
        }),
      );
      const agent = await agentRes.json();

      const { handleCreateVault } = await import("../src/handlers/vaults");
      const res = await handleCreateVault(
        req("/v1/vaults", {
          body: { display_name: "meta-vault", agent_id: agent.id, metadata: { env: "test" } },
        }),
      );
      const body = await res.json();
      expect(typeof body.metadata).toBe("object");
      expect(body.metadata).not.toBeNull();
    });
  });

  // =========================================================================
  // Environment
  // =========================================================================
  describe("Environment response shape", () => {
    // Environment creation via handler requires a real provider (docker etc.)
    // which isn't available in the test sandbox. Instead we insert a ready
    // environment directly in the DB and fetch it via handleGetEnvironment.

    it("has all Anthropic-required fields", async () => {
      await bootDb();
      const env = await createReadyEnv({ name: "spec-test-env" });

      const { handleGetEnvironment } = await import("../src/handlers/environments");
      const res = await handleGetEnvironment(req(`/v1/environments/${env.id}`), env.id as string);
      expect(res.status).toBe(200);
      const body = await res.json();

      for (const field of ENVIRONMENT_REQUIRED_FIELDS) {
        expect(body, `Environment missing required field: ${field}`).toHaveProperty(field);
      }
    });

    it("type field is 'environment'", async () => {
      await bootDb();
      const env = await createReadyEnv({ name: "type-env" });

      const { handleGetEnvironment } = await import("../src/handlers/environments");
      const res = await handleGetEnvironment(req(`/v1/environments/${env.id}`), env.id as string);
      const body = await res.json();
      expect(body.type).toBe("environment");
    });

    it("config is an object with type field", async () => {
      await bootDb();
      const env = await createReadyEnv({ name: "config-env" });

      const { handleGetEnvironment } = await import("../src/handlers/environments");
      const res = await handleGetEnvironment(req(`/v1/environments/${env.id}`), env.id as string);
      const body = await res.json();
      expect(typeof body.config).toBe("object");
      expect(body.config).toHaveProperty("type");
    });

    it("metadata is an object", async () => {
      await bootDb();
      const env = await createReadyEnv({ name: "meta-env" });

      const { handleGetEnvironment } = await import("../src/handlers/environments");
      const res = await handleGetEnvironment(req(`/v1/environments/${env.id}`), env.id as string);
      const body = await res.json();
      expect(typeof body.metadata).toBe("object");
      expect(body.metadata).not.toBeNull();
    });
  });

  // =========================================================================
  // List response pagination shape
  // =========================================================================
  describe("List response shape — next_page pagination", () => {
    it("agents list has data + next_page, no has_more/first_id/last_id", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      await handleCreateAgent(
        req("/v1/agents", { body: { name: "list-a1", model: { id: "claude-sonnet-4-6" } } }),
      );

      const { handleListAgents } = await import("../src/handlers/agents");
      const res = await handleListAgents(req("/v1/agents"));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toHaveProperty("data");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body).toHaveProperty("next_page");
      expect(body).not.toHaveProperty("has_more");
      expect(body).not.toHaveProperty("first_id");
      expect(body).not.toHaveProperty("last_id");
    });

    it("sessions list has data + next_page, no has_more/first_id/last_id", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", { body: { name: "list-session-agent", model: { id: "claude-sonnet-4-6" } } }),
      );
      const agent = await agentRes.json();
      const env = await createReadyEnv({ name: "list-session-env" });

      const { handleCreateSession } = await import("../src/handlers/sessions");
      await handleCreateSession(
        req("/v1/sessions", { body: { agent: agent.id, environment_id: env.id } }),
      );

      const { handleListSessions } = await import("../src/handlers/sessions");
      const res = await handleListSessions(req("/v1/sessions"));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toHaveProperty("data");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body).toHaveProperty("next_page");
      expect(body).not.toHaveProperty("has_more");
      expect(body).not.toHaveProperty("first_id");
      expect(body).not.toHaveProperty("last_id");
    });

    it("environments list has data + next_page, no has_more/first_id/last_id", async () => {
      await bootDb();
      await createReadyEnv({ name: "list-env-1" });

      const { handleListEnvironments } = await import("../src/handlers/environments");
      const res = await handleListEnvironments(req("/v1/environments"));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toHaveProperty("data");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body).toHaveProperty("next_page");
      expect(body).not.toHaveProperty("has_more");
      expect(body).not.toHaveProperty("first_id");
      expect(body).not.toHaveProperty("last_id");
    });

    it("vaults list has data + next_page, no has_more/first_id/last_id", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", { body: { name: "list-vault-agent", model: { id: "claude-sonnet-4-6" } } }),
      );
      const agent = await agentRes.json();

      const { handleCreateVault } = await import("../src/handlers/vaults");
      await handleCreateVault(
        req("/v1/vaults", { body: { display_name: "list-vault", agent_id: agent.id } }),
      );

      const { handleListVaults } = await import("../src/handlers/vaults");
      const res = await handleListVaults(req("/v1/vaults"));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toHaveProperty("data");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body).toHaveProperty("next_page");
      expect(body).not.toHaveProperty("has_more");
      expect(body).not.toHaveProperty("first_id");
      expect(body).not.toHaveProperty("last_id");
    });

    it("next_page is null when all results fit in one page", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      await handleCreateAgent(
        req("/v1/agents", { body: { name: "single-page", model: { id: "claude-sonnet-4-6" } } }),
      );

      const { handleListAgents } = await import("../src/handlers/agents");
      const res = await handleListAgents(req("/v1/agents"));
      const body = await res.json();
      expect(body.next_page).toBeNull();
    });
  });

  // =========================================================================
  // Cross-resource consistency
  // =========================================================================
  describe("Cross-resource consistency", () => {
    it("list items match single-resource shape", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const createRes = await handleCreateAgent(
        req("/v1/agents", { body: { name: "consistency-agent", model: { id: "claude-sonnet-4-6" } } }),
      );
      const created = await createRes.json();

      const { handleListAgents } = await import("../src/handlers/agents");
      const listRes = await handleListAgents(req("/v1/agents"));
      const listBody = await listRes.json();
      const listed = listBody.data[0];

      // All required fields present in listed item too
      for (const field of AGENT_REQUIRED_FIELDS) {
        expect(listed, `Listed agent missing field: ${field}`).toHaveProperty(field);
      }
      // Same id
      expect(listed.id).toBe(created.id);
      expect(listed.type).toBe("agent");
    });

    it("session from list matches single session shape", async () => {
      await bootDb();
      const { handleCreateAgent } = await import("../src/handlers/agents");
      const agentRes = await handleCreateAgent(
        req("/v1/agents", { body: { name: "list-sess-agent", model: { id: "claude-sonnet-4-6" } } }),
      );
      const agent = await agentRes.json();
      const env = await createReadyEnv({ name: "list-sess-env" });

      const { handleCreateSession } = await import("../src/handlers/sessions");
      const createRes = await handleCreateSession(
        req("/v1/sessions", { body: { agent: agent.id, environment_id: env.id } }),
      );
      const created = await createRes.json();

      const { handleListSessions } = await import("../src/handlers/sessions");
      const listRes = await handleListSessions(req("/v1/sessions"));
      const listBody = await listRes.json();
      const listed = listBody.data[0];

      for (const field of SESSION_REQUIRED_FIELDS) {
        expect(listed, `Listed session missing field: ${field}`).toHaveProperty(field);
      }
      expect(listed.id).toBe(created.id);
      expect(listed.type).toBe("session");
    });
  });
});
