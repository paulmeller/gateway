import { z } from "zod";
import { ENGINE_NAMES } from "../../registry";
import { routeWrap, jsonOk, paginatedOk, decodeCursor } from "../../http";

const ENGINE_ENUM = [...ENGINE_NAMES, "anthropic"] as unknown as [string, ...string[]];
import { getDb } from "../../db/client";
import { createAgent, getAgent, updateAgent, archiveAgent, listAgents, listAgentVersions } from "../../db/agents";
import { resolveBackend } from "../../backends/registry";
import { isProxied, markProxied, unmarkProxied, getProxiedTenantId } from "../../db/proxy";
import { forwardToAnthropic, validateAnthropicProxy } from "../../proxy/forward";
import { badRequest, notFound, conflict } from "../../errors";
import { assertResourceTenant, resolveCreateTenant, tenantFilter } from "../../auth/scope";
import type { AgentSkill, AuthContext } from "../../types";

/**
 * Load the tenant_id column for an agent row directly. The public
 * `Agent` hydrate doesn't expose it (intentionally — the API doesn't
 * surface tenancy in resource bodies). Used for tenant assertions.
 */
function getAgentTenantId(id: string): string | null | undefined {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM agents WHERE id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

/** Common resolve-or-404 guard with tenant scoping. */
function loadAgentForCaller(auth: AuthContext, id: string, version?: number) {
  const tenantId = getAgentTenantId(id);
  if (tenantId === undefined) throw notFound(`agent ${id} not found`);
  assertResourceTenant(auth, tenantId, `agent ${id} not found`);
  const agent = getAgent(id, version);
  if (!agent) throw notFound(`agent ${id} not found`);
  return agent;
}

/**
 * Tenant guard for proxied agents. Proxied agents live in
 * `proxy_resources` and have no row in the local `agents` table, so
 * the regular loadAgentForCaller can't help. Legacy rows (no
 * tenant_id) resolve as global-admin-only.
 */
function assertProxiedAgentTenant(auth: AuthContext, id: string): void {
  const proxied = getProxiedTenantId(id);
  if (proxied === undefined) return; // not proxied after all
  assertResourceTenant(auth, proxied, `agent ${id} not found`);
}

/** Our inline skill format (content embedded on the agent). */
const InlineSkillSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  content: z.string().min(1).max(256 * 1024), // 256KB per skill
  files: z.record(z.string(), z.string()).optional(),
  installed_at: z.string().optional(),
});

/** Anthropic format: reference to a DB-stored skill by ID. */
const RefSkillSchema = z.object({
  skill_id: z.string().min(1),
  type: z.enum(["custom", "anthropic"]).optional(),
  version: z.string().optional(),
});

const SkillSchema = z.union([InlineSkillSchema, RefSkillSchema]);

const ToolSchema = z.union([
  z.object({
    type: z.literal("agent_toolset_20260401"),
    configs: z
      .array(z.object({ name: z.string(), enabled: z.boolean().optional() }))
      .optional(),
    default_config: z.object({ enabled: z.boolean().optional() }).optional(),
  }),
  z.object({
    type: z.literal("custom"),
    name: z.string().min(1),
    description: z.string(),
    input_schema: z.record(z.unknown()),
  }),
]);

const ModelConfigSchema = z.object({
  speed: z.enum(["standard", "fast"]).optional(),
});

/**
 * Fetch an entire skill directory from the Anthropic skills repo on GitHub.
 * Uses the GitHub API to list the directory tree, then fetches each file.
 * Binary files (images, compiled) are stored with a `base64:` prefix.
 */
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".py", ".js", ".ts", ".sh", ".json", ".yaml", ".yml",
  ".html", ".css", ".xml", ".csv", ".toml", ".cfg", ".ini", ".sql",
  ".jsx", ".tsx", ".mjs", ".cjs", ".rb", ".go", ".rs", ".java",
]);

async function fetchAnthropicSkill(skillName: string): Promise<{ content: string; files: Record<string, string> }> {
  const rawBase = `https://raw.githubusercontent.com/anthropics/skills/main/skills/${skillName}`;
  const files: Record<string, string> = {};

  // Use the git trees API (single request) to get the full file list.
  // This avoids multiple contents API calls that hit rate limits.
  const treeResp = await fetch(
    `https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!treeResp.ok) {
    // Fallback: if tree API is rate-limited, just fetch SKILL.md
    const mdResp = await fetch(`${rawBase}/SKILL.md`, { signal: AbortSignal.timeout(10_000) });
    if (!mdResp.ok) throw new Error(`SKILL.md not found for ${skillName}`);
    const content = await mdResp.text();
    return { content, files: { "SKILL.md": content } };
  }

  const tree = (await treeResp.json()) as { tree: Array<{ path: string; type: string }> };
  const prefix = `skills/${skillName}/`;
  const skillFiles = tree.tree.filter(
    (f) => f.type === "blob" && f.path.startsWith(prefix),
  );

  if (skillFiles.length === 0) {
    throw new Error(`No files found for skill "${skillName}"`);
  }

  // Fetch each file from raw.githubusercontent.com (no rate limit)
  let skillMdContent = "";
  await Promise.all(
    skillFiles.map(async (f) => {
      const relativePath = f.path.slice(prefix.length);
      const ext = relativePath.substring(relativePath.lastIndexOf(".")).toLowerCase();
      const isText = TEXT_EXTENSIONS.has(ext) || relativePath === "LICENSE.txt";

      try {
        const resp = await fetch(`${rawBase}/${relativePath}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return;

        if (isText) {
          const text = await resp.text();
          files[relativePath] = text;
          if (relativePath === "SKILL.md") skillMdContent = text;
        } else {
          const buf = Buffer.from(await resp.arrayBuffer());
          files[relativePath] = `base64:${buf.toString("base64")}`;
        }
      } catch {
        // Skip files that fail to download
      }
    }),
  );

  if (!skillMdContent) {
    throw new Error(`No SKILL.md found in anthropics/skills/skills/${skillName}`);
  }

  return { content: skillMdContent, files };
}

/**
 * Resolve a mixed array of inline skills and DB skill references into
 * the canonical `AgentSkill[]` shape stored on agent_versions.
 */
async function resolveSkillInputs(
  skills: z.infer<typeof SkillSchema>[] | undefined,
  nowIso: string,
): Promise<AgentSkill[] | undefined> {
  if (!skills) return undefined;
  const resolved: AgentSkill[] = [];
  for (const s of skills) {
    // Anthropic format: reference to a DB-stored or hosted skill
    if ("skill_id" in s && s.skill_id) {
      const { getSkill: dbGetSkill, getSkillVersion: dbGetSkillVersion } = await import("../../db/skills");
      const dbSkill = dbGetSkill(s.skill_id);

      if (dbSkill) {
        // DB-stored skill (custom or previously uploaded)
        const version = s.version ?? dbSkill.latest_version;
        const sv = dbGetSkillVersion(s.skill_id, version);
        if (!sv) throw badRequest(`skill version ${version} not found for skill ${s.skill_id}`);
        resolved.push({
          name: dbSkill.display_title,
          source: `skill:${s.skill_id}@${version}`,
          content: sv.content,
          ...(sv.files && Object.keys(sv.files).length > 0 ? { files: sv.files } : {}),
          installed_at: nowIso,
        });
      } else if (s.type === "anthropic" || !s.type) {
        // Anthropic-hosted skill — fetch entire directory from GitHub anthropics/skills repo
        const skillName = s.skill_id;
        try {
          const result = await fetchAnthropicSkill(skillName);
          resolved.push({
            name: skillName,
            source: `anthropic:${skillName}`,
            content: result.content,
            ...(Object.keys(result.files).length > 0 ? { files: result.files } : {}),
            installed_at: nowIso,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[agents] failed to fetch Anthropic skill "${skillName}":`, msg);
          throw badRequest(
            `skill "${skillName}" not found in local DB or Anthropic skills repo (${msg}). ` +
            `Upload it via POST /v1/skills or check the skill_id. ` +
            `Available Anthropic skills: docx, pdf, pptx, xlsx, mcp-builder, frontend-design`,
          );
        }
      } else {
        throw badRequest(`skill "${s.skill_id}" not found`);
      }
    } else {
      // Our inline format — pass through as-is
      const inline = s as z.infer<typeof InlineSkillSchema>;
      resolved.push({
        name: inline.name,
        source: inline.source,
        content: inline.content,
        ...(inline.files && Object.keys(inline.files).length > 0 ? { files: inline.files } : {}),
        installed_at: inline.installed_at ?? nowIso,
      });
    }
  }
  return resolved;
}

const CreateSchema = z.object({
  name: z.string().min(1),
  model: z.union([
    z.string().min(1).transform((s) => ({ id: s })),
    z.object({ id: z.string().min(1), speed: z.enum(["standard", "fast"]).optional() }),
  ]),
  description: z.string().max(2048).optional(),
  metadata: z.record(z.string(), z.string().max(512)).optional(),
  system: z.string().nullish(),
  tools: z.array(ToolSchema).optional(),
  mcp_servers: z.array(
    z.object({
      name: z.string(),
      type: z.string().optional(),
      url: z.string().optional(),
    }).passthrough(),
  ).optional(),
  engine: z.enum(ENGINE_ENUM).optional(),
  webhook_url: z.string().url().optional(),
  webhook_events: z.array(z.string()).optional(),
  /**
   * v0.5: shared secret for HMAC signing of webhook deliveries. Min
   * length 32 to nudge toward strong entropy; values shorter than that
   * are almost always a typo or misplaced username.
   */
  webhook_secret: z.string().min(32).max(512).optional(),
  threads_enabled: z.boolean().optional(),
  confirmation_mode: z.boolean().optional(),
  callable_agents: z.array(z.object({
    type: z.literal("agent"),
    id: z.string(),
    version: z.number().int().optional(),
  })).optional(),
  multiagent: z.object({
    type: z.literal("coordinator"),
    agents: z.array(z.union([
      z.object({ type: z.literal("agent"), id: z.string(), version: z.number().int().optional() }),
      z.object({ type: z.literal("self") }),
    ])).max(20),
  }).optional(),
  permission_policy: z.object({
    always_allow: z.array(z.string()).optional(),
    always_ask: z.array(z.string()).optional(),
  }).optional(),
  skills: z.array(SkillSchema).max(20).optional(),
  model_config: ModelConfigSchema.optional(),
  /** v0.5: required for global admin, ignored for tenant users. */
  tenant_id: z.string().optional(),
}).refine(data => {
  if (!data.metadata) return true;
  return Object.keys(data.metadata).length <= 16;
}, "metadata exceeds 16 key limit").refine(data => {
  if (!data.skills) return true;
  const total = data.skills.reduce((sum, s) => {
    // Only inline skills have content; ref skills (skill_id) have no inline content
    return sum + ((s as { content?: string }).content?.length ?? 0);
  }, 0);
  return total <= 1024 * 1024; // 1MB total
}, "Total skills content exceeds 1MB limit");

const UpdateSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().min(1).optional(),
  model: z.union([
    z.string().min(1).transform((s) => ({ id: s })),
    z.object({ id: z.string().min(1), speed: z.enum(["standard", "fast"]).optional() }),
  ]).optional(),
  description: z.string().max(2048).optional(),
  metadata: z.record(z.string(), z.string().max(512)).optional(),
  system: z.string().nullish(),
  tools: z.array(z.unknown()).optional(),
  mcp_servers: z.array(
    z.object({
      name: z.string(),
      type: z.string().optional(),
      url: z.string().optional(),
    }).passthrough(),
  ).optional(),
  webhook_url: z.string().url().nullish(),
  webhook_events: z.array(z.string()).optional(),
  /** Null clears the secret (unsigned webhooks); string rotates it. */
  webhook_secret: z.string().min(32).max(512).nullish(),
  confirmation_mode: z.boolean().optional(),
  callable_agents: z.array(z.object({
    type: z.literal("agent"),
    id: z.string(),
    version: z.number().int().optional(),
  })).optional(),
  multiagent: z.object({
    type: z.literal("coordinator"),
    agents: z.array(z.union([
      z.object({ type: z.literal("agent"), id: z.string(), version: z.number().int().optional() }),
      z.object({ type: z.literal("self") }),
    ])).max(20),
  }).nullish(),
  permission_policy: z.object({
    always_allow: z.array(z.string()).optional(),
    always_ask: z.array(z.string()).optional(),
  }).nullish(),
  skills: z.array(SkillSchema).max(20).optional(),
  model_config: ModelConfigSchema.optional(),
}).refine(data => {
  if (!data.metadata) return true;
  return Object.keys(data.metadata).length <= 16;
}, "metadata exceeds 16 key limit").refine(data => {
  if (!data.skills) return true;
  const total = data.skills.reduce((sum, s) => {
    return sum + ((s as { content?: string }).content?.length ?? 0);
  }, 0);
  return total <= 1024 * 1024; // 1MB total
}, "Total skills content exceeds 1MB limit");

export function handleCreateAgent(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const rawBody = await request.text();
    const body = rawBody ? JSON.parse(rawBody) : null;
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(`invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }

    const createTenantId = resolveCreateTenant(auth, parsed.data.tenant_id);

    // Check for duplicate name within the caller's tenant scope.
    const existing = listAgents({ limit: 1000, tenantFilter: tenantFilter(auth) });
    if (existing.some(a => a.name === parsed.data.name)) {
      throw conflict(`Agent with name "${parsed.data.name}" already exists`);
    }

    // Infer engine from model prefix if not explicitly set.
    // e.g. "gemini-3.5-flash" → engine "gemini", "gpt-5.4" → engine "codex".
    const { inferEngineFromModel } = await import("../../backends/models");
    const backendName = (parsed.data.engine
      ?? inferEngineFromModel(parsed.data.model.id)
      ?? "claude") as import("../../backends/types").AnyBackendName;

    if (backendName === "anthropic") {
      const proxyErr = validateAnthropicProxy();
      if (proxyErr) throw badRequest(proxyErr);
      const proxyRes = await forwardToAnthropic(request, "/v1/agents", { body: rawBody });
      if (proxyRes.ok) {
        try {
          const data = (await proxyRes.clone().json()) as { id: string };
          // Stamp the caller's tenant so subsequent cross-tenant access
          // attempts against this proxy-only resource are rejected.
          markProxied(data.id, "agent", createTenantId);
        } catch { /* best-effort */ }
      }
      return proxyRes;
    }

    const backend = resolveBackend(backendName);

    const modelId = parsed.data.model.id;
    const modelSpeed = "speed" in parsed.data.model ? parsed.data.model.speed : undefined;

    // Validate model is supported by this engine
    const { isValidModelForEngine, FALLBACK_MODELS } = await import("../../backends/models");
    if (!isValidModelForEngine(backendName, modelId)) {
      throw badRequest(
        `Model "${modelId}" is not supported by the ${backendName} engine. ` +
        `Supported models: ${(FALLBACK_MODELS[backendName] ?? []).join(", ")}`,
      );
    }

    if (backendName !== "claude" && parsed.data.tools && parsed.data.tools.length > 0) {
      throw badRequest(
        `${backendName} backend does not use agent tool configs; tools are managed by the backend's internal permission system. Omit the tools field for ${backendName} agents.`,
      );
    }

    const createErr = backend.validateAgentCreation?.();
    if (createErr) throw badRequest(createErr);

    // Convert array→record for DB storage
    const mcpInput = parsed.data.mcp_servers;
    let mcpRecord: Record<string, unknown> = {};
    if (mcpInput) {
      for (const s of mcpInput) {
        const { name, ...rest } = s;
        mcpRecord[name] = { type: rest.type ?? "url", ...rest };
      }
    }

    // Merge model_config with speed from model object input
    const mergedModelConfig = {
      ...(parsed.data.model_config ?? {}),
      ...(modelSpeed ? { speed: modelSpeed } : {}),
    };

    const nowIso = new Date().toISOString();
    const agent = createAgent({
      name: parsed.data.name,
      model: modelId,
      description: parsed.data.description,
      metadata: parsed.data.metadata,
      system: parsed.data.system ?? null,
      tools: parsed.data.tools ?? [{ type: "agent_toolset_20260401" }],
      mcp_servers: mcpRecord as Record<string, import("../../types").McpServerConfig>,
      backend: backendName,
      webhook_url: parsed.data.webhook_url ?? null,
      webhook_events: parsed.data.webhook_events,
      webhook_secret: parsed.data.webhook_secret ?? null,
      threads_enabled: parsed.data.threads_enabled ?? (parsed.data.multiagent ? true : false),
      confirmation_mode: parsed.data.confirmation_mode ?? false,
      callable_agents: parsed.data.callable_agents,
      multiagent: parsed.data.multiagent,
      permission_policy: parsed.data.permission_policy,
      skills: await resolveSkillInputs(parsed.data.skills, nowIso),
      model_config: mergedModelConfig,
      tenant_id: createTenantId,
    });
    return jsonOk(agent, 201);
  });
}

export function handleListAgents(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit");
    const order = url.searchParams.get("order") as "asc" | "desc" | null;
    const includeArchived = url.searchParams.get("include_archived") === "true";
    const cursor = decodeCursor(url.searchParams.get("after_id") ?? url.searchParams.get("page"));

    const requestedLimit = limit ? Number(limit) : 20;
    const data = listAgents({
      limit: requestedLimit,
      order: order ?? undefined,
      includeArchived,
      cursor,
      tenantFilter: tenantFilter(auth),
    });
    return paginatedOk(data, requestedLimit);
  });
}

export function handleGetAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedAgentTenant(auth, id);
      return forwardToAnthropic(request, `/v1/agents/${id}`);
    }
    const url = new URL(request.url);
    const versionParam = url.searchParams.get("version");
    const version = versionParam ? Number(versionParam) : undefined;
    const agent = loadAgentForCaller(auth, id, version);
    return jsonOk(agent);
  });
}

export function handleUpdateAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedAgentTenant(auth, id);
      return forwardToAnthropic(request, `/v1/agents/${id}`);
    }
    const current = loadAgentForCaller(auth, id); // tenant guard
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

    if (body && typeof body === "object" && "backend" in body) {
      throw badRequest("backend cannot be changed after agent creation");
    }

    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    // Optimistic concurrency: version must match current
    if (current.version !== parsed.data.version) {
      throw conflict(`Version mismatch: expected ${current.version}, got ${parsed.data.version}`);
    }

    const modelId = parsed.data.model?.id;
    const modelSpeed = parsed.data.model && "speed" in parsed.data.model ? parsed.data.model.speed : undefined;

    // Convert array→record for DB storage
    let mcpRecord: Record<string, unknown> | undefined;
    if (parsed.data.mcp_servers !== undefined) {
      mcpRecord = {};
      for (const s of parsed.data.mcp_servers) {
        const { name, ...rest } = s;
        mcpRecord[name] = { type: rest.type ?? "url", ...rest };
      }
    }

    // Merge model_config with speed from model object input
    const mergedModelConfig = parsed.data.model_config || modelSpeed
      ? { ...(parsed.data.model_config ?? {}), ...(modelSpeed ? { speed: modelSpeed } : {}) }
      : undefined;

    const nowIso = new Date().toISOString();
    const updated = updateAgent(id, {
      name: parsed.data.name,
      model: modelId,
      description: parsed.data.description,
      metadata: parsed.data.metadata,
      system: parsed.data.system,
      tools: parsed.data.tools as never,
      mcp_servers: mcpRecord as never,
      webhook_url: parsed.data.webhook_url,
      webhook_events: parsed.data.webhook_events,
      webhook_secret: parsed.data.webhook_secret,
      confirmation_mode: parsed.data.confirmation_mode,
      callable_agents: parsed.data.callable_agents,
      multiagent: parsed.data.multiagent,
      permission_policy: parsed.data.permission_policy,
      skills: await resolveSkillInputs(parsed.data.skills, nowIso),
      model_config: mergedModelConfig,
    });
    if (!updated) throw notFound(`agent ${id} not found`);
    return jsonOk(updated);
  });
}

export function handleDeleteAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedAgentTenant(auth, id);
      const res = await forwardToAnthropic(request, `/v1/agents/${id}`);
      if (res.ok) unmarkProxied(id);
      return res;
    }
    loadAgentForCaller(auth, id); // tenant guard — throws 404 on cross-tenant
    const ok = archiveAgent(id);
    if (!ok) throw notFound(`agent ${id} not found`);
    return jsonOk({ id, type: "agent_deleted" });
  });
}

export function handleArchiveAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    if (isProxied(id)) {
      assertProxiedAgentTenant(auth, id);
      const res = await forwardToAnthropic(request, `/v1/agents/${id}/archive`);
      if (res.ok) unmarkProxied(id);
      return res;
    }
    loadAgentForCaller(auth, id); // tenant guard
    const ok = archiveAgent(id);
    if (!ok) throw notFound(`agent ${id} not found`);
    const agent = getAgent(id)!;
    return jsonOk(agent);
  });
}

export function handleListAgentVersions(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    loadAgentForCaller(auth, id); // tenant guard
    const url = new URL(req.url);
    const limit = url.searchParams.get("limit");
    const cursorRaw = decodeCursor(url.searchParams.get("after_id") ?? url.searchParams.get("page"));
    const cursor = cursorRaw ? Number(cursorRaw) : undefined;

    const requestedLimit = limit ? Number(limit) : 20;
    const data = listAgentVersions(id, {
      limit: requestedLimit,
      cursor,
    });

    const hasMore = data.length === requestedLimit;
    const firstId = data.length > 0 ? String(data[0].version) : null;
    const lastId = data.length > 0 ? String(data[data.length - 1].version) : null;
    return jsonOk({ data, has_more: hasMore, first_id: firstId, last_id: lastId });
  });
}
