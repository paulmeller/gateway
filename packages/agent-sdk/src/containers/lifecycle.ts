/**
 * Session-scoped sprite lifecycle.
 *
 * - Sprites are reserved **lazily** on the first user.message, not at
 *   `POST /v1/sessions` time. This keeps session creation fast and decoupled
 *   from sprite provisioning latency.
 * - Each session is pinned 1:1 to a sprite for its lifetime. No rebalancing.
 * - There is no park/restore capability: sprites.dev checkpoints are
 *   per-sprite only (no cross-sprite restore) and there is no suspend API.
 *   Idle sessions are evicted by the sweeper — see `sessions/sweeper.ts`.
 * - Orphan reconciliation runs on startup and periodically from the sweeper.
 */
import { createSprite, deleteSprite, listSprites } from "./client";
import * as pool from "./pool";
import { installClaudeWrapper } from "../backends/claude/wrapper-script";
import { resolveBackend } from "../backends/registry";
import { getAgent } from "../db/agents";
import { getEnvironment, getEnvironmentRow } from "../db/environments";
import {
  getSession,
  getSessionRow,
  setSessionSprite,
} from "../db/sessions";
import { appendEvent } from "../sessions/bus";
import { getConfig } from "../config";
import { ApiError } from "../errors";
import { nowMs } from "../util/clock";
import { resolveContainerProvider } from "../providers/registry";
import { dockerProvider } from "../providers/docker";
import { resolveVaultSecrets } from "../providers/resolve-secrets";
import type { SessionResource, AgentSkill } from "../types";

const SPRITE_NAME_PREFIX = "ca-sess-";

/**
 * Install agent skills into the container.
 *
 * For Claude backend: writes skills to /home/agent/.claude/skills/<name>/SKILL.md
 * For all backends: also writes to /home/agent/.agents/skills/<name>/SKILL.md
 */
export async function installSkills(
  spriteName: string,
  provider: import("../providers/types").ContainerProvider,
  skills: AgentSkill[],
  engine: string,
): Promise<void> {
  if (!skills || skills.length === 0) return;

  if (engine === "claude") {
    // Claude Code reads from .claude/skills/ directory
    await provider.exec(spriteName, ["bash", "-c", "mkdir -p /home/agent/.claude/skills"]);

    for (const skill of skills) {
      // Write each skill as a SKILL.md file in its own directory
      const dirPath = `/home/agent/.claude/skills/${skill.name}`;
      const filePath = `${dirPath}/SKILL.md`;
      await provider.exec(spriteName, ["bash", "-c", `mkdir -p ${dirPath}`]);

      // Use stdin to write content (safe for special characters)
      await provider.exec(spriteName, ["bash", "-c", `cat > ${filePath}`], {
        stdin: skill.content,
      });
    }
  }

  // Also write to .agents/skills/ for universal agent compatibility
  await provider.exec(spriteName, ["bash", "-c", "mkdir -p /home/agent/.agents/skills"]);
  for (const skill of skills) {
    const dirPath = `/home/agent/.agents/skills/${skill.name}`;
    const filePath = `${dirPath}/SKILL.md`;
    await provider.exec(spriteName, ["bash", "-c", `mkdir -p ${dirPath}`]);
    await provider.exec(spriteName, ["bash", "-c", `cat > ${filePath}`], {
      stdin: skill.content,
    });
  }
}

function deriveSpriteName(sessionId: string): string {
  // Stable prefix + ULID tail, lowercased (sprites.dev requires lowercase names).
  return `${SPRITE_NAME_PREFIX}${sessionId.replace(/^sess_/, "").toLowerCase()}`;
}

/**
 * Acquire a sprite for the session if one is not already bound. Called
 * from the driver on the first turn (not from the session create route).
 *
 * Runs the agent's backend-specific `prepareOnSprite` hook after the sprite
 * is created. For claude this is a sub-second wrapper install; for opencode
 * it's a ~10-second npm install + symlink.
 *
 * For backends with non-trivial prep time, emits
 * `span.environment_setup_{start,end}` events so streaming clients can see
 * the delay isn't a hang. Claude's prep is fast enough that we skip the
 * spans to avoid noise.
 */
export async function acquireForFirstTurn(sessionId: string): Promise<string> {
  const row = getSessionRow(sessionId);
  if (!row) throw new ApiError(404, "not_found_error", `session not found: ${sessionId}`);
  if (row.sprite_name) return row.sprite_name;

  const env = getEnvironmentRow(row.environment_id);
  if (!env) throw new ApiError(404, "not_found_error", "environment not found");
  if (env.state !== "ready") {
    throw new ApiError(
      400,
      "invalid_request_error",
      `environment is not ready (state=${env.state})`,
    );
  }

  if (pool.countInEnv(env.id) >= getConfig().maxSpritesPerEnv) {
    throw new ApiError(503, "server_busy", "env sprite pool exhausted");
  }

  const agent = getAgent(row.agent_id, row.agent_version);
  if (!agent) {
    throw new ApiError(404, "not_found_error", "agent not found for session");
  }
  const backend = resolveBackend(agent.engine);

  // Resolve the container provider from the environment config.
  // Defaults to "sprites" for backward compatibility.
  const envObj = getEnvironment(row.environment_id);
  const provider = await resolveContainerProvider(envObj?.config?.provider);

  // Resolve vault secrets for provider auth (vault > process.env)
  const sessionForSecrets = getSession(sessionId);
  const secrets = sessionForSecrets?.vault_ids?.length
    ? resolveVaultSecrets(sessionForSecrets.vault_ids)
    : {};

  // Pre-flight: re-check provider availability (may have changed since env creation)
  if (provider.checkAvailability) {
    const result = await provider.checkAvailability(secrets);
    if (!result.available) {
      throw new Error(`provider ${provider.name} is not available: ${result.message}`);
    }
  }

  // Wrap provider so all exec/startExec calls automatically include vault secrets.
  // This avoids threading secrets through every backend function signature.
  const hasSecrets = Object.keys(secrets).length > 0;
  const sp = hasSecrets ? {
    ...provider,
    exec: (n: string, argv: string[], opts?: Parameters<typeof provider.exec>[2]) =>
      provider.exec(n, argv, { ...opts, secrets }),
    startExec: (n: string, opts: Parameters<typeof provider.startExec>[1]) =>
      provider.startExec(n, { ...opts, secrets }),
    create: (opts: Parameters<typeof provider.create>[0]) =>
      provider.create({ ...opts, secrets }),
    delete: (n: string, s?: Record<string, string>) =>
      provider.delete(n, s ?? secrets),
  } : provider;

  const name = deriveSpriteName(sessionId);
  console.log(`[lifecycle] ${sessionId} creating container via ${sp.name}...`);
  await sp.create({ name });
  console.log(`[lifecycle] ${sessionId} container created: ${name}`);

  // Backends with slow prep (e.g. opencode's npm install) bracket the work
  // with span events so the client sees something on the event stream
  // rather than a minute of silence. Non-spec event type — clients that
  // don't recognize it should drop it silently.
  const needsSlowPrep = backend.name !== "claude";
  if (needsSlowPrep) {
    appendEvent(sessionId, {
      type: "span.environment_setup_start",
      payload: { backend: backend.name },
      origin: "server",
      processedAt: nowMs(),
    });
  }

  try {
    console.log(`[lifecycle] ${sessionId} installing ${backend.name} engine on container...`);
    await backend.prepareOnSprite(name, sp);
    console.log(`[lifecycle] ${sessionId} engine installed`);

    // Install custom tool bridge if the agent has custom tools or threads_enabled (claude backend only)
    if (agent.engine === "claude") {
      const customTools = agent.tools.filter(
        (t): t is import("../types").CustomTool => t.type === "custom",
      );
      // If threads are enabled, add spawn_agent as a synthetic custom tool
      const allBridgeTools = [...customTools];
      if (agent.threads_enabled) {
        allBridgeTools.push({
          type: "custom",
          name: "spawn_agent",
          description: "Spawn a sub-agent to handle a task. Returns the sub-agent's response.",
          input_schema: {
            type: "object",
            properties: {
              agent_id: { type: "string", description: "ID of the agent to spawn" },
              prompt: { type: "string", description: "Task for the sub-agent" },
            },
            required: ["agent_id", "prompt"],
          },
        });
      }
      if (allBridgeTools.length > 0) {
        const { installToolBridge } = await import("../backends/claude/index");
        await installToolBridge(name, allBridgeTools, sp);
      }

      // Install permission hook if confirmation_mode is enabled
      if (agent.confirmation_mode) {
        const { installPermissionHook } = await import("../backends/claude/index");
        await installPermissionHook(name, sp);
      }
    }

    // Install agent skills into the container
    if (agent.skills && agent.skills.length > 0) {
      console.log(`[lifecycle] ${sessionId} installing ${agent.skills.length} skill(s)...`);
      await installSkills(name, sp, agent.skills, agent.engine);
      console.log(`[lifecycle] ${sessionId} skills installed`);
    }
  } catch (err) {
    await sp.delete(name).catch(() => {});
    throw err;
  }

  if (needsSlowPrep) {
    appendEvent(sessionId, {
      type: "span.environment_setup_end",
      payload: { backend: backend.name },
      origin: "server",
      processedAt: nowMs(),
    });
  }

  // Provision resources into the container if the session has any
  const session = getSession(sessionId);
  if (session?.resources && session.resources.length > 0) {
    await provisionResources(name, session.resources, sp);
  }

  pool.register({
    spriteName: name,
    envId: env.id,
    sessionId,
    createdAt: nowMs(),
    vaultSecrets: Object.keys(secrets).length > 0 ? secrets : undefined,
  });
  setSessionSprite(sessionId, name);
  return name;
}

/**
 * Download/write resources into /tmp/resources/ in the container.
 * URIs are fetched via global fetch; text resources are written directly.
 */
async function provisionResources(
  spriteName: string,
  resources: SessionResource[],
  provider: import("../providers/types").ContainerProvider,
): Promise<void> {
  await provider.exec(spriteName, ["mkdir", "-p", "/tmp/resources"]);

  for (let i = 0; i < resources.length; i++) {
    const r = resources[i];
    const filename = `/tmp/resources/resource_${i}`;

    if (r.type === "uri" && r.uri) {
      const MAX_RESOURCE_BYTES = 50 * 1024 * 1024; // 50 MB
      try {
        const resp = await fetch(r.uri, { signal: AbortSignal.timeout(30000) });
        if (!resp.ok) {
          console.warn(`[lifecycle] failed to fetch resource ${r.uri}: ${resp.status}`);
          continue;
        }
        const contentLength = resp.headers.get("Content-Length");
        if (contentLength && parseInt(contentLength, 10) > MAX_RESOURCE_BYTES) {
          console.warn(`[lifecycle] skipping resource ${r.uri}: Content-Length ${contentLength} exceeds 50 MB limit`);
          continue;
        }
        const content = await resp.text();
        if (Buffer.byteLength(content, "utf8") > MAX_RESOURCE_BYTES) {
          console.warn(`[lifecycle] skipping resource ${r.uri}: body size exceeds 50 MB limit`);
          continue;
        }
        await provider.exec(spriteName, ["bash", "-c", `cat > ${filename}`], { stdin: content });
      } catch (err) {
        console.warn(`[lifecycle] failed to provision URI resource ${r.uri}:`, err);
      }
    } else if (r.type === "text" && r.content) {
      try {
        await provider.exec(spriteName, ["bash", "-c", `cat > ${filename}`], { stdin: r.content });
      } catch (err) {
        console.warn(`[lifecycle] failed to provision text resource:`, err);
      }
    }
  }
}

// Re-export for test seeds and env setup that still use the claude wrapper path
export { installClaudeWrapper };

/**
 * Release and delete the sprite bound to this session. Best-effort — logs
 * failures but does not throw.
 */
export async function releaseSession(sessionId: string): Promise<void> {
  const entry = pool.unregister(sessionId);
  const row = getSessionRow(sessionId);
  const name = entry?.spriteName ?? row?.sprite_name ?? null;
  if (name) {
    const envObj = row ? getEnvironment(row.environment_id) : null;
    const provider = await resolveContainerProvider(envObj?.config?.provider);
    await provider.delete(name, entry?.vaultSecrets).catch((err: unknown) => {
      console.warn(`releaseSession: failed to delete container ${name}:`, err);
    });
  }
  if (row?.sprite_name) setSessionSprite(sessionId, null);
}

/**
 * Reconcile orphaned sprites. Compares sprites.dev's fleet against our
 * sessions table and deletes anything with our prefix that has no active
 * session. Run on startup and on a 1h interval.
 */
export async function reconcileOrphans(): Promise<{ deleted: number; kept: number }> {
  let deleted = 0;
  let kept = 0;

  const liveNames = new Set(
    pool.allSessionSprites().map((e) => e.spriteName).filter(Boolean),
  );

  let token: string | undefined;
  for (;;) {
    const res = await listSprites({
      prefix: SPRITE_NAME_PREFIX,
      max_results: 100,
      continuation_token: token,
    });
    for (const s of res.sprites) {
      if (liveNames.has(s.name)) {
        kept++;
      } else {
        await deleteSprite(s.name).catch(() => {});
        deleted++;
      }
    }
    if (!res.has_more) break;
    token = res.next_continuation_token ?? undefined;
    if (!token) break;
  }
  return { deleted, kept };
}

/**
 * Reconcile orphaned Docker containers. Same logic as reconcileOrphans
 * but uses the Docker provider's list method (`docker ps --filter`).
 * Run alongside reconcileOrphans on startup and on a 1h interval.
 */
export async function reconcileDockerOrphans(): Promise<{ deleted: number; kept: number }> {
  let deleted = 0;
  let kept = 0;

  const liveNames = new Set(
    pool.allSessionSprites().map((e) => e.spriteName).filter(Boolean),
  );

  const containers = await dockerProvider.list({ prefix: SPRITE_NAME_PREFIX });
  for (const c of containers) {
    if (liveNames.has(c.name)) {
      kept++;
    } else {
      await dockerProvider.delete(c.name).catch(() => {});
      deleted++;
    }
  }
  return { deleted, kept };
}

