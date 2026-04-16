/**
 * Anthropic sync — syncs local agent/vault/environment config to
 * Anthropic's managed agents API before proxying session traffic.
 *
 * Called at session creation time when the environment uses
 * provider: "anthropic". Idempotent — only syncs if the local
 * config has changed (detected via config_hash).
 */
import { getConfig } from "../config";
import { getAgent } from "../db/agents";
import { getEnvironment } from "../db/environments";
import { listEntries as listVaultEntries } from "../db/vaults";
import { getSyncRow, upsertSync, getSyncedRemoteId } from "../db/sync";
import { markProxied } from "../db/proxy";
import { injectMcpAuthHeaders } from "../sessions/mcp-auth";
import { createHash } from "crypto";
import type { Agent } from "../types";

const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";

// ── Helpers ──────────────────────────────────────────────────────────────

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": BETA_HEADER,
    "content-type": "application/json",
  };
}

async function anthropicPost<T>(path: string, body: unknown, apiKey: string): Promise<T> {
  const res = await fetch(`${ANTHROPIC_BASE}${path}`, {
    method: "POST",
    headers: anthropicHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "unknown error");
    throw new Error(`Anthropic API ${path} failed (${res.status}): ${err}`);
  }
  return res.json() as Promise<T>;
}

async function anthropicPut(path: string, body: unknown, apiKey: string): Promise<void> {
  const res = await fetch(`${ANTHROPIC_BASE}${path}`, {
    method: "PUT",
    headers: anthropicHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "unknown error");
    throw new Error(`Anthropic API PUT ${path} failed (${res.status}): ${err}`);
  }
}

function hashConfig(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}

// ── Sync functions ───────────────────────────────────────────────────────

/**
 * Sync a local agent to Anthropic. Returns the remote agent ID.
 * Skips if already synced with matching config hash.
 */
export async function syncAgent(
  agentId: string,
  vaultEntries: Array<{ key: string; value: string }>,
  apiKey: string,
): Promise<string> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  // Inject MCP auth headers from vault before syncing
  const agentWithAuth = injectMcpAuthHeaders(agent, vaultEntries);

  // Convert mcp_servers from Record to array format for Anthropic API
  const mcpArray = agentWithAuth.mcp_servers
    ? Object.entries(agentWithAuth.mcp_servers).map(([name, config]) => ({
        name,
        ...config,
      }))
    : [];

  const agentConfig: Record<string, unknown> = {
    name: agentWithAuth.name,
    model: agentWithAuth.model,
  };
  if (agentWithAuth.system) agentConfig.system = agentWithAuth.system;
  if (mcpArray.length > 0) agentConfig.mcp_servers = mcpArray;
  if (agentWithAuth.model_config && Object.keys(agentWithAuth.model_config).length > 0) {
    agentConfig.model_config = agentWithAuth.model_config;
  }
  const hash = hashConfig(agentConfig);

  // Check if already synced with same config
  const existing = getSyncRow(agentId, "agent");
  if (existing && existing.config_hash === hash) {
    return existing.remote_id;
  }

  // Create on Anthropic (always create new — Anthropic agents are immutable-ish)
  const remote = await anthropicPost<{ id: string }>("/v1/agents", agentConfig, apiKey);
  upsertSync(agentId, "agent", remote.id, hash);
  console.log(`[sync] agent ${agentId} → ${remote.id}`);
  return remote.id;
}

/**
 * Sync local vault entries to an Anthropic vault.
 * Creates the vault on Anthropic if needed, then puts all entries.
 * Returns the remote vault ID.
 */
export async function syncVault(
  vaultId: string,
  agentRemoteId: string,
  apiKey: string,
): Promise<string> {
  const entries = listVaultEntries(vaultId);
  // Filter out MCP_AUTH/MCP_HEADER keys — they're already baked into agent headers
  const MCP_KEY_RE = /^MCP_(AUTH|HEADER)_/i;
  const filteredEntries = entries.filter(e => !MCP_KEY_RE.test(e.key));

  const hash = hashConfig(filteredEntries.map(e => e.key).sort());

  const existing = getSyncRow(vaultId, "vault");
  if (existing && existing.config_hash === hash) {
    return existing.remote_id;
  }

  // Create vault on Anthropic (secrets are not synced — Anthropic's vault
  // secrets API is not yet available. The vault is created empty and passed
  // to the session for future use.)
  const remote = await anthropicPost<{ id: string }>("/v1/vaults", {
    display_name: `agentstep-${vaultId.slice(0, 12)}`,
  }, apiKey);

  upsertSync(vaultId, "vault", remote.id, hash);
  console.log(`[sync] vault ${vaultId} → ${remote.id}`);
  return remote.id;
}

/**
 * Sync a local environment to Anthropic. Returns the remote environment ID.
 */
export async function syncEnvironment(
  envId: string,
  apiKey: string,
): Promise<string> {
  const existing = getSyncedRemoteId(envId, "environment");
  if (existing) return existing;

  const env = getEnvironment(envId);
  const remote = await anthropicPost<{ id: string }>("/v1/environments", {
    name: env?.name ?? `agentstep-env-${envId.slice(0, 12)}`,
  }, apiKey);

  upsertSync(envId, "environment", remote.id);
  console.log(`[sync] environment ${envId} → ${remote.id}`);
  return remote.id;
}

/**
 * Full sync flow for session creation. Syncs agent, vault(s), and
 * environment, then creates a session on Anthropic.
 * Returns the remote session ID.
 */
export async function syncAndCreateSession(opts: {
  agentId: string;
  agentVersion?: number;
  environmentId: string;
  vaultIds?: string[];
  title?: string | null;
  apiKey: string;
}): Promise<{ remoteSessionId: string }> {
  const { agentId, environmentId, vaultIds, title, apiKey } = opts;

  // Load all vault entries for MCP auth injection
  const allVaultEntries: Array<{ key: string; value: string }> = [];
  if (vaultIds?.length) {
    for (const vid of vaultIds) {
      allVaultEntries.push(...listVaultEntries(vid));
    }
  }

  // Sync agent (with MCP auth headers injected)
  const remoteAgentId = await syncAgent(agentId, allVaultEntries, apiKey);

  // Sync vaults
  const remoteVaultIds: string[] = [];
  if (vaultIds?.length) {
    for (const vid of vaultIds) {
      const remoteVid = await syncVault(vid, remoteAgentId, apiKey);
      remoteVaultIds.push(remoteVid);
    }
  }

  // Sync environment
  const remoteEnvId = await syncEnvironment(environmentId, apiKey);

  // Create session on Anthropic
  const sessionBody: Record<string, unknown> = {
    agent: remoteAgentId,
    environment_id: remoteEnvId,
  };
  if (remoteVaultIds.length > 0) sessionBody.vault_ids = remoteVaultIds;
  if (title) sessionBody.title = title;

  const remoteSession = await anthropicPost<{ id: string }>("/v1/sessions", sessionBody, apiKey);
  console.log(`[sync] session created on Anthropic: ${remoteSession.id}`);

  return { remoteSessionId: remoteSession.id };
}
