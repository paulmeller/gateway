import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { getDb } from "../db/client";
import { createVault, getVault, deleteVault, listVaults, listEntries, getEntry, setEntry, deleteEntry } from "../db/vaults";
import { getAgent } from "../db/agents";
import { badRequest, notFound, conflict } from "../errors";
import { assertResourceTenant, resolveCreateTenant, tenantFilter } from "../auth/scope";
import type { AuthContext } from "../types";

function getVaultTenantId(id: string): string | null | undefined {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM vaults WHERE id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

function getAgentTenantId(id: string): string | null | undefined {
  const row = getDb()
    .prepare(`SELECT tenant_id FROM agents WHERE id = ?`)
    .get(id) as { tenant_id: string | null } | undefined;
  return row?.tenant_id;
}

export function loadVaultForCaller(auth: AuthContext, id: string) {
  const tenantId = getVaultTenantId(id);
  if (tenantId === undefined) throw notFound(`vault not found: ${id}`);
  assertResourceTenant(auth, tenantId, `vault not found: ${id}`);
  const vault = getVault(id);
  if (!vault) throw notFound(`vault not found: ${id}`);
  return vault;
}

/**
 * Mask a secret value for API responses. Returns preview showing
 * at most the first 4 chars and the last 2 chars, separated by asterisks.
 * Short values (<=6 chars) are fully masked.
 */
function maskValue(value: string): string {
  if (value.length <= 6) return "******";
  return `${value.slice(0, 4)}****${value.slice(-2)}`;
}

const CreateVaultSchema = z.object({
  agent_id: z.string().min(1),
  name: z.string().min(1).optional(),
  /** Anthropic-compatible alias for `name`. */
  display_name: z.string().min(1).optional(),
  /** v0.5: required for global admin, ignored for tenant users. */
  tenant_id: z.string().optional(),
}).refine(data => data.name || data.display_name, {
  message: "Either name or display_name is required",
});

const PutEntrySchema = z.object({
  value: z.string(),
});

export function handleCreateVault(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    const body = await request.json();
    const parsed = CreateVaultSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    // Agent tenant becomes the vault tenant — a vault always lives in its
    // agent's tenant. Tenant users can only attach to their own agents
    // (we raise 404 on cross-tenant); global admins must supply tenant_id
    // and it must match the agent's tenant.
    const agentTenantId = getAgentTenantId(parsed.data.agent_id);
    if (agentTenantId === undefined) {
      throw notFound(`agent not found: ${parsed.data.agent_id}`);
    }
    assertResourceTenant(auth, agentTenantId, `agent not found: ${parsed.data.agent_id}`);
    const agent = getAgent(parsed.data.agent_id);
    if (!agent) throw notFound(`agent not found: ${parsed.data.agent_id}`);

    const createTenantId = resolveCreateTenant(auth, parsed.data.tenant_id);
    if (createTenantId !== agentTenantId) {
      throw badRequest(
        `vault tenant_id must match agent tenant_id (${agentTenantId})`,
      );
    }

    // Resolve name from either field (name takes precedence)
    const vaultName = (parsed.data.name ?? parsed.data.display_name)!;

    // Check for duplicate vault name on same agent
    const existing = listVaults({ agent_id: parsed.data.agent_id, tenantFilter: tenantFilter(auth) });
    if (existing.some(v => v.name === vaultName)) {
      throw conflict(`Vault "${vaultName}" already exists for this agent`);
    }

    const vault = createVault({
      agent_id: parsed.data.agent_id,
      name: vaultName,
      tenant_id: createTenantId,
    });
    return jsonOk({ ...vault, display_name: vault.name }, 201);
  });
}

export function handleListVaults(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth, request: req }) => {
    const url = new URL(req.url);
    const agentId = url.searchParams.get("agent_id") ?? undefined;
    const data = listVaults({ agent_id: agentId, tenantFilter: tenantFilter(auth) });
    return jsonOk({ data });
  });
}

export function handleGetVault(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    return jsonOk(loadVaultForCaller(auth, id));
  });
}

export function handleDeleteVault(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, id); // tenant guard
    const deleted = deleteVault(id);
    if (!deleted) throw notFound(`vault not found: ${id}`);
    return jsonOk({ id, type: "vault_deleted" });
  });
}

export function handleListEntries(request: Request, vaultId: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard
    // Return keys with masked values — never expose plaintext via list API
    const entries = listEntries(vaultId);
    const data = entries.map(e => ({ key: e.key, value: maskValue(e.value) }));
    return jsonOk({ data });
  });
}

export function handleGetEntry(request: Request, vaultId: string, key: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard
    const entry = getEntry(vaultId, key);
    if (!entry) throw notFound(`entry not found: ${key}`);
    // Mask value — plaintext is only available to server-side consumers (driver, sync)
    return jsonOk({ key: entry.key, value: maskValue(entry.value) });
  });
}

export function handlePutEntry(request: Request, vaultId: string, key: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard

    const body = await request.json();
    const parsed = PutEntrySchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    setEntry(vaultId, key, parsed.data.value);
    return jsonOk({ key, ok: true });
  });
}

export function handleDeleteEntry(request: Request, vaultId: string, key: string): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    loadVaultForCaller(auth, vaultId); // tenant guard
    const deleted = deleteEntry(vaultId, key);
    if (!deleted) throw notFound(`entry not found: ${key}`);
    return jsonOk({ key, type: "entry_deleted" });
  });
}
