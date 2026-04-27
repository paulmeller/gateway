/**
 * Session-scoped sandbox lifecycle.
 *
 * - Sprites are reserved **lazily** on the first user.message, not at
 *   `POST /v1/sessions` time. This keeps session creation fast and decoupled
 *   from sandbox provisioning latency.
 * - Each session is pinned 1:1 to a sandbox for its lifetime. No rebalancing.
 * - There is no park/restore capability: sprites.dev checkpoints are
 *   per-sandbox only (no cross-sandbox restore) and there is no suspend API.
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
  setSessionSandbox,
} from "../db/sessions";
import { appendEvent } from "../sessions/bus";
import { getConfig } from "../config";
import { ApiError } from "../errors";
import { nowMs } from "../util/clock";
import { resolveContainerProvider } from "../providers/registry";
import { dockerProvider } from "../providers/docker";
import { resolveVaultSecrets } from "../providers/resolve-secrets";
import type { SessionResource, AgentSkill } from "../types";

// Gate container-lifecycle logs behind DEBUG_LIFECYCLE=1 so a busy
// gateway's logs aren't dominated by per-session creation chatter.
const lcLog = (...args: unknown[]): void => {
  if (process.env.DEBUG_LIFECYCLE === "1") console.log(...args);
};

const SANDBOX_NAME_PREFIX = "ca-sess-";

/**
 * Wrap a container provider so every call automatically threads vault secrets.
 *
 * Used at sandbox acquisition (initial provision) and from the driver when
 * re-injecting skills / re-provisioning resources between turns. Without
 * this wrap, callers that resolve a fresh provider via the registry would
 * lose vault-sourced credentials (e.g. SPRITE_TOKEN) and the underlying
 * exec/create calls would 500 on auth.
 */
export function wrapProviderWithSecrets(
  provider: import("../providers/types").ContainerProvider,
  secrets: Record<string, string> | undefined,
): import("../providers/types").ContainerProvider {
  if (!secrets || Object.keys(secrets).length === 0) return provider;
  return {
    ...provider,
    exec: (n, argv, opts?) => provider.exec(n, argv, { ...opts, secrets }),
    startExec: (n, opts) => provider.startExec(n, { ...opts, secrets }),
    create: (opts) => provider.create({ ...opts, secrets }),
    delete: (n, s?) => provider.delete(n, s ?? secrets),
  };
}

/**
 * Install agent skills into the container.
 *
 * For Claude backend: writes skills to /home/agent/.claude/skills/<name>/SKILL.md
 * For all backends: also writes to /home/agent/.agents/skills/<name>/SKILL.md
 */
export async function installSkills(
  sandboxName: string,
  provider: import("../providers/types").ContainerProvider,
  skills: AgentSkill[],
  engine: string,
): Promise<void> {
  if (!skills || skills.length === 0) return;

  // Sanitize skill names — only allow safe directory characters
  const SAFE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
  const safeSkills = skills.filter((s) => {
    if (!SAFE_NAME_RE.test(s.name)) {
      console.warn(`[lifecycle] skipping skill with unsafe name: ${s.name.slice(0, 40)}`);
      return false;
    }
    return true;
  });

  if (engine === "claude") {
    // Claude Code reads from .claude/skills/ directory
    await provider.exec(sandboxName, ["mkdir", "-p", "/home/agent/.claude/skills"]);

    for (const skill of safeSkills) {
      const dirPath = `/home/agent/.claude/skills/${skill.name}`;
      const filePath = `${dirPath}/SKILL.md`;
      await provider.exec(sandboxName, ["mkdir", "-p", dirPath]);
      await provider.exec(sandboxName, ["sh", "-c", "cat > \"$1\"", "sh", filePath], {
        stdin: skill.content,
      });
    }
  }

  // Also write to .agents/skills/ for universal agent compatibility
  await provider.exec(sandboxName, ["mkdir", "-p", "/home/agent/.agents/skills"]);
  for (const skill of safeSkills) {
    const dirPath = `/home/agent/.agents/skills/${skill.name}`;
    const filePath = `${dirPath}/SKILL.md`;
    await provider.exec(sandboxName, ["mkdir", "-p", dirPath]);
    await provider.exec(sandboxName, ["sh", "-c", "cat > \"$1\"", "sh", filePath], {
      stdin: skill.content,
    });
  }
}

function deriveSandboxName(sessionId: string): string {
  // Stable prefix + ULID tail, lowercased (sprites.dev requires lowercase names).
  return `${SANDBOX_NAME_PREFIX}${sessionId.replace(/^sess_/, "").toLowerCase()}`;
}

/**
 * Acquire a sandbox for the session if one is not already bound. Called
 * from the driver on the first turn (not from the session create route).
 *
 * Runs the agent's backend-specific `prepareOnSandbox` hook after the sandbox
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
  if (row.sandbox_name) return row.sandbox_name;

  const env = getEnvironmentRow(row.environment_id);
  if (!env) throw new ApiError(404, "not_found_error", "environment not found");
  if (env.state !== "ready") {
    throw new ApiError(
      400,
      "invalid_request_error",
      `environment is not ready (state=${env.state})`,
    );
  }

  if (pool.countInEnv(env.id) >= getConfig().maxSandboxesPerEnv) {
    throw new ApiError(503, "server_busy", "env sandbox pool exhausted");
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
  const sp = wrapProviderWithSecrets(provider, secrets);

  const name = deriveSandboxName(sessionId);
  lcLog(`[lifecycle] ${sessionId} creating container via ${sp.name}...`);
  try {
    await sp.create({ name });
    lcLog(`[lifecycle] ${sessionId} container created: ${name}`);
  } catch (err) {
    // If the container already exists (e.g. server restarted mid-setup),
    // reuse it instead of failing. The engine may already be installed.
    if (String(err).includes("already exists")) {
      lcLog(`[lifecycle] ${sessionId} container ${name} already exists, reusing`);
    } else {
      throw err;
    }
  }

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
    lcLog(`[lifecycle] ${sessionId} installing ${backend.name} engine on container...`);
    await backend.prepareOnSandbox(name, sp);
    lcLog(`[lifecycle] ${sessionId} engine installed`);

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
      lcLog(`[lifecycle] ${sessionId} installing ${agent.skills.length} skill(s)...`);
      await installSkills(name, sp, agent.skills, agent.engine);
      lcLog(`[lifecycle] ${sessionId} skills installed`);
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

  // Provision resources into the container if the session has any.
  // Prefer the session_resources table; fall back to resources_json for backward compat.
  const { listResources: listSessionResources } = await import("../db/session-resources");
  const tableResources = listSessionResources(sessionId);
  if (tableResources.length > 0) {
    // Convert session_resources rows to SessionResource shape for provisioning
    const mapped: SessionResource[] = tableResources.map((r) => {
      if (r.type === "file") return { type: "file", file_id: r.file_id, mount_path: r.mount_path };
      if (r.type === "github_repository") {
        const checkout = r.checkout;
        return {
          type: "github_repository" as const,
          repository_url: r.url,
          mount_path: r.mount_path,
          branch: checkout?.type === "branch" ? checkout.name : undefined,
          commit: checkout?.type === "commit" ? checkout.name : undefined,
        };
      }
      return { type: "uri" as const, uri: r.url, mount_path: r.mount_path };
    });
    await provisionResources(name, mapped, sp);
  } else {
    // Backward compat: fall back to session's resources_json
    const session = getSession(sessionId);
    if (session?.resources && session.resources.length > 0) {
      await provisionResources(name, session.resources, sp);
    }
  }

  pool.register({
    sandboxName: name,
    envId: env.id,
    sessionId,
    createdAt: nowMs(),
    vaultSecrets: Object.keys(secrets).length > 0 ? secrets : undefined,
  });
  setSessionSandbox(sessionId, name);
  return name;
}

/**
 * Download/write resources into the container.
 *
 * Mount paths:
 *   - If mount_path specified: /uploads/{mount_path}
 *   - Otherwise: /tmp/resources/resource_{i}
 *
 * Resource types:
 *   - uri: fetched via HTTP
 *   - text: written directly
 *   - file: read from local disk storage
 *   - github_repository: cloned via git
 */
export async function provisionResources(
  sandboxName: string,
  resources: SessionResource[],
  provider: import("../providers/types").ContainerProvider,
): Promise<void> {
  await provider.exec(sandboxName, ["mkdir", "-p", "/mnt/session/resources", "/mnt/session/uploads", "/mnt/session/outputs"]);
  const MAX_RESOURCE_BYTES = 50 * 1024 * 1024; // 50 MB
  // Sanitize mount_path — only safe path characters, no traversal
  const SAFE_PATH_RE = /^[a-zA-Z0-9_./\-]+$/;
  function sanitizeMountPath(p: string | undefined): string | undefined {
    if (!p) return undefined;
    if (!SAFE_PATH_RE.test(p) || p.includes("..")) {
      console.warn(`[lifecycle] rejecting unsafe mount_path: ${p.slice(0, 40)}`);
      return undefined;
    }
    return p;
  }

  for (let i = 0; i < resources.length; i++) {
    const r = resources[i];
    const safeMountPath = sanitizeMountPath(r.mount_path);
    let mountTarget: string;
    if (safeMountPath) {
      // If mount_path starts with / it's an absolute path, use it as-is
      mountTarget = safeMountPath.startsWith("/") ? safeMountPath : `/mnt/session/uploads/${safeMountPath}`;
    } else if (r.type === "file" && r.file_id) {
      // Default for file resources: /mnt/session/uploads/<file_id>/<filename>
      const { getFile: getFileRow } = await import("../db/files");
      const fileRow = getFileRow(r.file_id);
      const fname = fileRow?.filename ?? `file_${i}`;
      mountTarget = `/mnt/session/uploads/${r.file_id}/${fname}`;
    } else {
      mountTarget = `/mnt/session/resources/resource_${i}`;
    }

    // Ensure parent directory exists — use argv form (no shell)
    const dir = mountTarget.substring(0, mountTarget.lastIndexOf("/"));
    if (dir) {
      await provider.exec(sandboxName, ["mkdir", "-p", dir]);
    }

    // Write content using "sh -c 'cat > \"$1\"' sh <path>" pattern —
    // the path is passed as a positional arg, never shell-interpolated.
    // After writing, chmod a-w to make the mount read-only.
    const writeTo = async (target: string, content: string) => {
      await provider.exec(sandboxName, ["sh", "-c", "cat > \"$1\"", "sh", target], { stdin: content });
      await provider.exec(sandboxName, ["chmod", "a-w", target]);
    };

    if (r.type === "uri" && r.uri) {
      try {
        const resp = await fetch(r.uri, { signal: AbortSignal.timeout(30000) });
        if (!resp.ok) {
          console.warn(`[lifecycle] failed to fetch resource ${r.uri}: ${resp.status}`);
          continue;
        }
        const contentLength = resp.headers.get("Content-Length");
        if (contentLength && parseInt(contentLength, 10) > MAX_RESOURCE_BYTES) {
          console.warn(`[lifecycle] skipping resource ${r.uri}: too large`);
          continue;
        }
        const content = await resp.text();
        if (Buffer.byteLength(content, "utf8") > MAX_RESOURCE_BYTES) {
          console.warn(`[lifecycle] skipping resource ${r.uri}: body too large`);
          continue;
        }
        await writeTo(mountTarget, content);
      } catch (err) {
        console.warn(`[lifecycle] failed to provision URI resource ${r.uri}:`, err);
      }
    } else if (r.type === "text" && r.content) {
      try {
        await writeTo(mountTarget, r.content);
      } catch (err) {
        console.warn(`[lifecycle] failed to provision text resource:`, err);
      }
    } else if (r.type === "file" && r.file_id) {
      try {
        const { getFile } = await import("../db/files");
        const { readFile: readStoredFile } = await import("../files/storage");
        const fileRow = getFile(r.file_id);
        if (!fileRow) {
          console.warn(`[lifecycle] file not found: ${r.file_id}`);
          continue;
        }
        const data = readStoredFile(fileRow.storage_path);
        if (data.length > MAX_RESOURCE_BYTES) {
          console.warn(`[lifecycle] skipping file ${r.file_id}: too large`);
          continue;
        }
        await writeTo(mountTarget, data.toString("utf8"));
      } catch (err) {
        console.warn(`[lifecycle] failed to provision file resource ${r.file_id}:`, err);
      }
    } else if (r.type === "github_repository") {
      // Accept both internal (repository_url) and Anthropic API (url) field names
      const cloneUrl = r.repository_url ?? (r as Record<string, unknown>).url as string | undefined;
      if (!cloneUrl) continue;
      try {
        const repoDir = safeMountPath
          ? (safeMountPath.startsWith("/") ? safeMountPath : `/mnt/session/uploads/${safeMountPath}`)
          : `/mnt/session/resources/repo_${i}`;
        // Validate branch/commit — alphanumeric + hyphen/dot/slash only
        const SAFE_REF_RE = /^[a-zA-Z0-9_./\-]+$/;
        const safeBranch = r.branch && SAFE_REF_RE.test(r.branch) ? r.branch : undefined;
        const safeCommit = r.commit && SAFE_REF_RE.test(r.commit) ? r.commit : undefined;
        if (r.branch && !safeBranch) console.warn(`[lifecycle] rejecting unsafe branch: ${r.branch.slice(0, 40)}`);
        if (r.commit && !safeCommit) console.warn(`[lifecycle] rejecting unsafe commit: ${r.commit.slice(0, 40)}`);

        // Build git clone as argv array — no shell interpolation
        const gitArgs = ["git", "clone", "--depth", "1"];
        if (safeBranch) { gitArgs.push("--branch", safeBranch); }
        gitArgs.push("--", cloneUrl, repoDir);
        const result = await provider.exec(sandboxName, gitArgs, { timeoutMs: 120_000 });
        if (safeCommit && result.exit_code === 0) {
          await provider.exec(sandboxName, ["git", "-C", repoDir, "checkout", safeCommit], { timeoutMs: 30_000 });
        }
        if (result.exit_code !== 0) {
          console.warn(`[lifecycle] git clone failed for ${cloneUrl}: ${result.stderr.slice(0, 200)}`);
        }
      } catch (err) {
        console.warn(`[lifecycle] failed to clone repo ${cloneUrl}:`, err);
      }
    }
  }
}

// Re-export for test seeds and env setup that still use the claude wrapper path
export { installClaudeWrapper };

/**
 * Release and delete the sandbox bound to this session. Best-effort — logs
 * failures but does not throw.
 */
export async function releaseSession(sessionId: string): Promise<void> {
  const entry = pool.unregister(sessionId);
  const row = getSessionRow(sessionId);
  const name = entry?.sandboxName ?? row?.sandbox_name ?? null;
  if (name) {
    const envObj = row ? getEnvironment(row.environment_id) : null;
    const provider = await resolveContainerProvider(envObj?.config?.provider);
    await provider.delete(name, entry?.vaultSecrets).catch((err: unknown) => {
      console.warn(`releaseSession: failed to delete container ${name}:`, err);
    });
  }
  if (row?.sandbox_name) setSessionSandbox(sessionId, null);
}

/**
 * Reconcile orphaned sandboxes. Compares sprites.dev's fleet against our
 * sessions table and deletes anything with our prefix that has no active
 * session. Run on startup and on a 1h interval.
 */
export async function reconcileOrphanSandboxes(): Promise<{ deleted: number; kept: number }> {
  let deleted = 0;
  let kept = 0;

  const liveNames = new Set(
    pool.allSessionSandboxes().map((e) => e.sandboxName).filter(Boolean),
  );

  let token: string | undefined;
  for (;;) {
    const res = await listSprites({
      prefix: SANDBOX_NAME_PREFIX,
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
 * Reconcile orphaned Docker containers. Same logic as reconcileOrphanSandboxes
 * but uses the Docker provider's list method (`docker ps --filter`).
 * Run alongside reconcileOrphanSandboxes on startup and on a 1h interval.
 */
export async function reconcileDockerOrphanSandboxes(): Promise<{ deleted: number; kept: number }> {
  let deleted = 0;
  let kept = 0;

  const liveNames = new Set(
    pool.allSessionSandboxes().map((e) => e.sandboxName).filter(Boolean),
  );

  const containers = await dockerProvider.list({ prefix: SANDBOX_NAME_PREFIX });
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

