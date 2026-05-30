// @ts-nocheck — test file with loose typing on handler responses
/**
 * Skills CRUD + versioning tests.
 *
 * Covers: create, get, list, delete, version CRUD, auto-increment,
 * cannot-delete-current-version, and Anthropic skill format on agent create.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure (same pattern as api-comprehensive.test.ts)
// ---------------------------------------------------------------------------

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-skills-test-"));
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

async function bootDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb(); // triggers migrations
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-12345" });
  return key;
}

function req(
  url: string,
  opts: { method?: string; body?: unknown; apiKey?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Skills CRUD", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("creates a skill with first version", async () => {
    await bootDb();
    const { handleCreateSkill } = await import("../src/handlers/skills-write");

    const res = await handleCreateSkill(
      req("/v1/skills", {
        body: { name: "test-skill", description: "A test skill", content: "# Skill content" },
      }),
    );
    expect(res.status).toBe(201);
    const skill = await res.json();
    expect(skill.type).toBe("skill");
    expect(skill.name).toBe("test-skill");
    expect(skill.description).toBe("A test skill");
    expect(skill.current_version).toBe("1.0.0");
    expect(skill.id).toMatch(/^skill_/);
  });

  it("gets a skill by id", async () => {
    await bootDb();
    const { handleCreateSkill, handleGetSkill } = await import("../src/handlers/skills-write");

    const createRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "my-skill", content: "hello" } }),
    );
    const created = await createRes.json();

    const getRes = await handleGetSkill(req(`/v1/skills/${created.id}`), created.id);
    expect(getRes.status).toBe(200);
    const skill = await getRes.json();
    expect(skill.id).toBe(created.id);
    expect(skill.name).toBe("my-skill");
  });

  it("returns 404 for non-existent skill", async () => {
    await bootDb();
    const { handleGetSkill } = await import("../src/handlers/skills-write");
    const res = await handleGetSkill(req("/v1/skills/skill_NONEXIST"), "skill_NONEXIST");
    expect(res.status).toBe(404);
  });

  it("deletes a skill (hard delete)", async () => {
    await bootDb();
    const { handleCreateSkill, handleGetSkill, handleDeleteSkill } = await import("../src/handlers/skills-write");

    const createRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "del-skill", content: "content" } }),
    );
    const created = await createRes.json();

    const delRes = await handleDeleteSkill(
      req(`/v1/skills/${created.id}`, { method: "DELETE" }),
      created.id,
    );
    expect(delRes.status).toBe(200);
    const body = await delRes.json();
    expect(body.type).toBe("skill_deleted");

    // Confirm it's gone
    const getRes = await handleGetSkill(req(`/v1/skills/${created.id}`), created.id);
    expect(getRes.status).toBe(404);
  });

  it("returns 404 when deleting non-existent skill", async () => {
    await bootDb();
    const { handleDeleteSkill } = await import("../src/handlers/skills-write");
    const res = await handleDeleteSkill(
      req("/v1/skills/skill_NONEXIST", { method: "DELETE" }),
      "skill_NONEXIST",
    );
    expect(res.status).toBe(404);
  });

  it("lists skills", async () => {
    await bootDb();
    const { handleCreateSkill } = await import("../src/handlers/skills-write");
    const { listSkills } = await import("../src/db/skills");

    await handleCreateSkill(req("/v1/skills", { body: { name: "s1", content: "c1" } }));
    await handleCreateSkill(req("/v1/skills", { body: { name: "s2", content: "c2" } }));
    await handleCreateSkill(req("/v1/skills", { body: { name: "s3", content: "c3" } }));

    const skills = listSkills({ limit: 10 });
    expect(skills.length).toBe(3);
  });
});

describe("Skill Versions", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("creates a new version with auto-increment", async () => {
    await bootDb();
    const { handleCreateSkill, handleCreateSkillVersion } = await import("../src/handlers/skills-write");

    const createRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "versioned", content: "v1 content" } }),
    );
    const skill = await createRes.json();

    const vRes = await handleCreateSkillVersion(
      req(`/v1/skills/${skill.id}/versions`, { body: { content: "v2 content" } }),
      skill.id,
    );
    expect(vRes.status).toBe(201);
    const version = await vRes.json();
    expect(version.type).toBe("skill_version");
    expect(version.version).toBe("1.0.1"); // auto-incremented from 1.0.0
    expect(version.content).toBe("v2 content");
    expect(version.skill_id).toBe(skill.id);
  });

  it("creates a version with explicit version string", async () => {
    await bootDb();
    const { handleCreateSkill, handleCreateSkillVersion } = await import("../src/handlers/skills-write");

    const createRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "explicit", content: "v1" } }),
    );
    const skill = await createRes.json();

    const vRes = await handleCreateSkillVersion(
      req(`/v1/skills/${skill.id}/versions`, { body: { content: "v2", version: "2.0.0" } }),
      skill.id,
    );
    expect(vRes.status).toBe(201);
    const version = await vRes.json();
    expect(version.version).toBe("2.0.0");
  });

  it("updates skill current_version after creating a version", async () => {
    await bootDb();
    const { handleCreateSkill, handleCreateSkillVersion, handleGetSkill } = await import("../src/handlers/skills-write");

    const createRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "cv", content: "v1" } }),
    );
    const skill = await createRes.json();

    await handleCreateSkillVersion(
      req(`/v1/skills/${skill.id}/versions`, { body: { content: "v2" } }),
      skill.id,
    );

    const getRes = await handleGetSkill(req(`/v1/skills/${skill.id}`), skill.id);
    const updated = await getRes.json();
    expect(updated.current_version).toBe("1.0.1");
  });

  it("lists versions", async () => {
    await bootDb();
    const { handleCreateSkill, handleCreateSkillVersion, handleListSkillVersions } = await import("../src/handlers/skills-write");

    const createRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "lv", content: "v1" } }),
    );
    const skill = await createRes.json();

    await handleCreateSkillVersion(
      req(`/v1/skills/${skill.id}/versions`, { body: { content: "v2" } }),
      skill.id,
    );
    await handleCreateSkillVersion(
      req(`/v1/skills/${skill.id}/versions`, { body: { content: "v3" } }),
      skill.id,
    );

    const listRes = await handleListSkillVersions(
      req(`/v1/skills/${skill.id}/versions`),
      skill.id,
    );
    expect(listRes.status).toBe(200);
    const body = await listRes.json();
    expect(body.data.length).toBe(3); // 1.0.0, 1.0.1, 1.0.2
  });

  it("gets a specific version", async () => {
    await bootDb();
    const { handleCreateSkill, handleGetSkillVersion } = await import("../src/handlers/skills-write");

    const createRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "sv", content: "first version content" } }),
    );
    const skill = await createRes.json();

    const getRes = await handleGetSkillVersion(
      req(`/v1/skills/${skill.id}/versions/1.0.0`),
      skill.id,
      "1.0.0",
    );
    expect(getRes.status).toBe(200);
    const version = await getRes.json();
    expect(version.version).toBe("1.0.0");
    expect(version.content).toBe("first version content");
  });

  it("returns 404 for non-existent version", async () => {
    await bootDb();
    const { handleCreateSkill, handleGetSkillVersion } = await import("../src/handlers/skills-write");

    const createRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "ne", content: "c" } }),
    );
    const skill = await createRes.json();

    const res = await handleGetSkillVersion(
      req(`/v1/skills/${skill.id}/versions/9.9.9`),
      skill.id,
      "9.9.9",
    );
    expect(res.status).toBe(404);
  });

  it("deletes a non-current version", async () => {
    await bootDb();
    const { handleCreateSkill, handleCreateSkillVersion, handleDeleteSkillVersion, handleGetSkillVersion } = await import("../src/handlers/skills-write");

    const createRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "dv", content: "v1" } }),
    );
    const skill = await createRes.json();

    // Create a second version — now current_version = 1.0.1
    await handleCreateSkillVersion(
      req(`/v1/skills/${skill.id}/versions`, { body: { content: "v2" } }),
      skill.id,
    );

    // Delete the old version 1.0.0 (not current)
    const delRes = await handleDeleteSkillVersion(
      req(`/v1/skills/${skill.id}/versions/1.0.0`, { method: "DELETE" }),
      skill.id,
      "1.0.0",
    );
    expect(delRes.status).toBe(200);
    const body = await delRes.json();
    expect(body.type).toBe("skill_version_deleted");

    // Confirm it's gone
    const getRes = await handleGetSkillVersion(
      req(`/v1/skills/${skill.id}/versions/1.0.0`),
      skill.id,
      "1.0.0",
    );
    expect(getRes.status).toBe(404);
  });

  it("cannot delete the current version", async () => {
    await bootDb();
    const { handleCreateSkill, handleDeleteSkillVersion } = await import("../src/handlers/skills-write");

    const createRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "cd", content: "v1" } }),
    );
    const skill = await createRes.json();

    // Try to delete the current version (1.0.0)
    const delRes = await handleDeleteSkillVersion(
      req(`/v1/skills/${skill.id}/versions/1.0.0`, { method: "DELETE" }),
      skill.id,
      "1.0.0",
    );
    expect(delRes.status).toBe(400);
    const body = await delRes.json();
    expect(body.error.message).toContain("cannot delete the current version");
  });

  it("returns 404 when creating version for non-existent skill", async () => {
    await bootDb();
    const { handleCreateSkillVersion } = await import("../src/handlers/skills-write");

    const res = await handleCreateSkillVersion(
      req("/v1/skills/skill_NONEXIST/versions", { body: { content: "c" } }),
      "skill_NONEXIST",
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when listing versions for non-existent skill", async () => {
    await bootDb();
    const { handleListSkillVersions } = await import("../src/handlers/skills-write");

    const res = await handleListSkillVersions(
      req("/v1/skills/skill_NONEXIST/versions"),
      "skill_NONEXIST",
    );
    expect(res.status).toBe(404);
  });
});

describe("Anthropic skill format on agent create", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("accepts skill_id references and resolves content from DB", async () => {
    await bootDb();
    const { handleCreateSkill } = await import("../src/handlers/skills-write");
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    // First create a DB-stored skill
    const skillRes = await handleCreateSkill(
      req("/v1/skills", {
        body: { name: "db-skill", description: "from DB", content: "# DB Skill\nDo something." },
      }),
    );
    const skill = await skillRes.json();

    // Create an environment for the agent
    const { handleCreateEnvironment } = await import("../src/handlers/anthropic-compat/environments");
    await handleCreateEnvironment(
      req("/anthropic/v1/environments", {
        body: { name: "test-env", config: { type: "cloud" } },
      }),
    );

    // Create an agent with Anthropic-format skill reference
    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "skill-agent",
          model: { id: "claude-sonnet-4-20250514" },
          skills: [{ skill_id: skill.id }],
        },
      }),
    );
    expect(agentRes.status).toBe(201);
    const agent = await agentRes.json();

    // The agent's skills should have the resolved content
    expect(agent.skills.length).toBe(1);
    expect(agent.skills[0].name).toBe("db-skill");
    expect(agent.skills[0].content).toBe("# DB Skill\nDo something.");
    expect(agent.skills[0].source).toBe(`skill:${skill.id}@1.0.0`);
  });

  it("accepts skill_id with explicit version", async () => {
    await bootDb();
    const { handleCreateSkill, handleCreateSkillVersion } = await import("../src/handlers/skills-write");
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    const skillRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "ver-skill", content: "v1" } }),
    );
    const skill = await skillRes.json();

    // Create a second version
    await handleCreateSkillVersion(
      req(`/v1/skills/${skill.id}/versions`, { body: { content: "v2 content" } }),
      skill.id,
    );

    // Create an agent referencing the first version
    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "ver-agent",
          model: { id: "claude-sonnet-4-20250514" },
          skills: [{ skill_id: skill.id, version: "1.0.0" }],
        },
      }),
    );
    expect(agentRes.status).toBe(201);
    const agent = await agentRes.json();
    expect(agent.skills[0].content).toBe("v1"); // v1, not v2
    expect(agent.skills[0].source).toBe(`skill:${skill.id}@1.0.0`);
  });

  it("returns 400 for non-existent skill_id", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "bad-skill-agent",
          model: { id: "claude-sonnet-4-20250514" },
          skills: [{ skill_id: "skill_DOESNOTEXIST" }],
        },
      }),
    );
    expect(agentRes.status).toBe(400);
  });

  it("accepts mixed inline and ref skills", async () => {
    await bootDb();
    const { handleCreateSkill } = await import("../src/handlers/skills-write");
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    const skillRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "ref-skill", content: "ref content" } }),
    );
    const skill = await skillRes.json();

    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "mixed-agent",
          model: { id: "claude-sonnet-4-20250514" },
          skills: [
            { name: "inline-skill", source: "local", content: "inline content" },
            { skill_id: skill.id },
          ],
        },
      }),
    );
    expect(agentRes.status).toBe(201);
    const agent = await agentRes.json();
    expect(agent.skills.length).toBe(2);
    expect(agent.skills[0].name).toBe("inline-skill");
    expect(agent.skills[0].content).toBe("inline content");
    expect(agent.skills[1].name).toBe("ref-skill");
    expect(agent.skills[1].content).toBe("ref content");
  });
});

describe("Skill validation", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("rejects create with missing name", async () => {
    await bootDb();
    const { handleCreateSkill } = await import("../src/handlers/skills-write");
    const res = await handleCreateSkill(
      req("/v1/skills", { body: { content: "something" } }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects create with missing content", async () => {
    await bootDb();
    const { handleCreateSkill } = await import("../src/handlers/skills-write");
    const res = await handleCreateSkill(
      req("/v1/skills", { body: { name: "no-content" } }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects version create with missing content", async () => {
    await bootDb();
    const { handleCreateSkill, handleCreateSkillVersion } = await import("../src/handlers/skills-write");

    const createRes = await handleCreateSkill(
      req("/v1/skills", { body: { name: "v", content: "c" } }),
    );
    const skill = await createRes.json();

    const res = await handleCreateSkillVersion(
      req(`/v1/skills/${skill.id}/versions`, { body: {} }),
      skill.id,
    );
    expect(res.status).toBe(400);
  });
});

describe("Anthropic skill GitHub resolution", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("resolves anthropic skill from GitHub when not in DB", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "docx-agent",
          model: { id: "claude-sonnet-4-6" },
          skills: [{ skill_id: "docx", type: "anthropic" }],
        },
      }),
    );
    expect(agentRes.status).toBe(201);
    const agent = await agentRes.json();
    expect(agent.skills.length).toBe(1);
    expect(agent.skills[0].name).toBe("docx");
    expect(agent.skills[0].source).toBe("anthropic:docx");
    expect(agent.skills[0].content.length).toBeGreaterThan(0);
  });

  it("DB skill takes precedence over GitHub when skill_id matches DB id", async () => {
    await bootDb();
    const { handleCreateSkill } = await import("../src/handlers/skills-write");
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    // Upload a local skill named "docx" to DB
    const skillRes = await handleCreateSkill(
      req("/v1/skills", {
        body: { name: "docx", description: "local override", content: "# Local docx skill" },
      }),
    );
    const skill = await skillRes.json();

    // Reference it by DB id with type: "anthropic" — DB should win
    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "db-docx-agent",
          model: { id: "claude-sonnet-4-6" },
          skills: [{ skill_id: skill.id, type: "anthropic" }],
        },
      }),
    );
    expect(agentRes.status).toBe(201);
    const agent = await agentRes.json();
    expect(agent.skills.length).toBe(1);
    // Source should start with "skill:" (DB), not "anthropic:"
    expect(agent.skills[0].source).toMatch(/^skill:/);
    expect(agent.skills[0].content).toBe("# Local docx skill");
  });

  it("returns 400 for non-existent anthropic skill", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "bad-anthropic-agent",
          model: { id: "claude-sonnet-4-6" },
          skills: [{ skill_id: "nonexistent-skill-xyz", type: "anthropic" }],
        },
      }),
    );
    expect(agentRes.status).toBe(400);
    const body = await agentRes.json();
    expect(body.error.message).toMatch(/not found/i);
  });

  it("resolves anthropic skill without explicit type field (implicit GitHub fallback)", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    // "docx" is not in the local DB (fresh DB), so it falls back to GitHub
    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "docx-implicit-agent",
          model: { id: "claude-sonnet-4-6" },
          skills: [{ skill_id: "docx" }],
        },
      }),
    );
    expect(agentRes.status).toBe(201);
    const agent = await agentRes.json();
    expect(agent.skills[0].name).toBe("docx");
    expect(agent.skills[0].source).toBe("anthropic:docx");
    expect(agent.skills[0].content.length).toBeGreaterThan(0);
  });

  it("returns 400 for custom type with missing skill (no GitHub fallback)", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "custom-missing-agent",
          model: { id: "claude-sonnet-4-6" },
          skills: [{ skill_id: "missing", type: "custom" }],
        },
      }),
    );
    expect(agentRes.status).toBe(400);
    const body = await agentRes.json();
    expect(body.error.message).toMatch(/not found/i);
  });

  it("resolves mixed inline + anthropic skills", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "mixed-anthropic-agent",
          model: { id: "claude-sonnet-4-6" },
          skills: [
            { name: "inline-skill", source: "local", content: "inline content here" },
            { skill_id: "docx", type: "anthropic" },
          ],
        },
      }),
    );
    expect(agentRes.status).toBe(201);
    const agent = await agentRes.json();
    expect(agent.skills.length).toBe(2);
    // Inline skill
    expect(agent.skills[0].name).toBe("inline-skill");
    expect(agent.skills[0].content).toBe("inline content here");
    expect(agent.skills[0].source).toBe("local");
    // Anthropic skill from GitHub
    expect(agent.skills[1].name).toBe("docx");
    expect(agent.skills[1].source).toBe("anthropic:docx");
    expect(agent.skills[1].content.length).toBeGreaterThan(0);
  });

  it.skipIf(process.env.CI)("docx skill includes supporting files beyond SKILL.md", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "docx-files-agent",
          model: { id: "claude-sonnet-4-6" },
          skills: [{ skill_id: "docx", type: "anthropic" }],
        },
      }),
    );
    expect(agentRes.status).toBe(201);
    const body = await agentRes.json();
    const skill = body.skills[0];

    // files should be present with at least SKILL.md
    expect(skill.files).toBeDefined();
    expect(typeof skill.files).toBe("object");
    expect(Object.keys(skill.files).length).toBeGreaterThanOrEqual(1);

    // SKILL.md must be one of the files
    expect(skill.files["SKILL.md"]).toBeDefined();
  });

  it("all files in docx skill have string content (non-binary files have text)", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "docx-nonempty-agent",
          model: { id: "claude-sonnet-4-6" },
          skills: [{ skill_id: "docx", type: "anthropic" }],
        },
      }),
    );
    expect(agentRes.status).toBe(201);
    const body = await agentRes.json();
    const skill = body.skills[0];

    expect(skill.files).toBeDefined();
    const entries = Object.entries(skill.files as Record<string, string>);
    // Every value must be a string (empty __init__.py files are valid)
    for (const [, content] of entries) {
      expect(typeof content).toBe("string");
    }
    // Most files should have non-empty content — verify the majority do
    const nonEmpty = entries.filter(([, c]) => c.length > 0);
    expect(nonEmpty.length).toBeGreaterThan(entries.length / 2);
  });

  it.skipIf(process.env.CI)("python scripts in docx skill are stored as plain text, not base64", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "docx-python-agent",
          model: { id: "claude-sonnet-4-6" },
          skills: [{ skill_id: "docx", type: "anthropic" }],
        },
      }),
    );
    expect(agentRes.status).toBe(201);
    const body = await agentRes.json();
    const skill = body.skills[0];

    expect(skill.files).toBeDefined();
    // If the upstream skill has .py scripts, verify they're stored as plain text
    const pyFiles = Object.entries(skill.files as Record<string, string>).filter(
      ([path]) => path.endsWith(".py"),
    );
    for (const [, content] of pyFiles) {
      expect(content.startsWith("base64:")).toBe(false);
    }
  });

  it("SKILL.md content matches top-level content field", async () => {
    await bootDb();
    const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");

    const agentRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "docx-skillmd-agent",
          model: { id: "claude-sonnet-4-6" },
          skills: [{ skill_id: "docx", type: "anthropic" }],
        },
      }),
    );
    expect(agentRes.status).toBe(201);
    const body = await agentRes.json();
    const skill = body.skills[0];

    expect(skill.files).toBeDefined();
    expect(skill.files["SKILL.md"]).toBeDefined();
    // The top-level content field should be exactly SKILL.md
    expect(skill.content).toBe(skill.files["SKILL.md"]);
  });
});

describe("Skills DB layer", () => {
  beforeEach(() => {
    freshDbEnv();
  });

  it("auto-increments versions correctly", async () => {
    await bootDb();
    const { createSkill, createSkillVersion } = await import("../src/db/skills");

    const skill = createSkill({ name: "auto", content: "v1" });
    expect(skill.current_version).toBe("1.0.0");

    const v2 = createSkillVersion(skill.id, { content: "v2" });
    expect(v2!.version).toBe("1.0.1");

    const v3 = createSkillVersion(skill.id, { content: "v3" });
    expect(v3!.version).toBe("1.0.2");
  });

  it("hard-deletes skill and all versions", async () => {
    await bootDb();
    const { createSkill, createSkillVersion, deleteSkill, listSkillVersions, getSkill } = await import("../src/db/skills");

    const skill = createSkill({ name: "hd", content: "v1" });
    createSkillVersion(skill.id, { content: "v2" });
    createSkillVersion(skill.id, { content: "v3" });

    expect(listSkillVersions(skill.id).length).toBe(3);
    expect(deleteSkill(skill.id)).toBe(true);
    expect(getSkill(skill.id)).toBeUndefined();
    expect(listSkillVersions(skill.id).length).toBe(0);
  });

  it("prevents deleting current version", async () => {
    await bootDb();
    const { createSkill, deleteSkillVersion } = await import("../src/db/skills");

    const skill = createSkill({ name: "nodel", content: "v1" });
    const result = deleteSkillVersion(skill.id, "1.0.0");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("cannot delete the current version");
  });
});

describe("Agent update with Anthropic skills", () => {
  beforeEach(() => { freshDbEnv(); });

  it("updates an existing agent to add an Anthropic skill", async () => {
    await bootDb();
    const { handleCreateAgent, handleUpdateAgent } = await import("../src/handlers/anthropic-compat/agents");

    // Create agent without skills
    const createRes = await handleCreateAgent(
      req("/anthropic/v1/agents", {
        body: {
          name: "update-skill-test",
          model: { id: "claude-sonnet-4-6" },
        },
      }),
    );
    expect(createRes.status).toBe(201);
    const agent = await createRes.json();
    expect(agent.skills).toHaveLength(0);

    // Update to add docx skill
    const updateRes = await handleUpdateAgent(
      req(`/anthropic/v1/agents/${agent.id}`, {
        method: "POST",
        body: {
          version: agent.version,
          skills: [{ skill_id: "docx", type: "anthropic" }],
        },
      }),
      agent.id,
    );
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.skills).toHaveLength(1);
    expect(updated.skills[0].name).toBe("docx");
    expect(updated.skills[0].source).toBe("anthropic:docx");
    expect(updated.skills[0].content.length).toBeGreaterThan(100);
  });
});
