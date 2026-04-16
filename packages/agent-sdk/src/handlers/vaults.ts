import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { createVault, getVault, deleteVault, listVaults, listEntries, getEntry, setEntry, deleteEntry } from "../db/vaults";
import { getAgent } from "../db/agents";
import { badRequest, notFound, conflict } from "../errors";

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
  name: z.string().min(1),
});

const PutEntrySchema = z.object({
  value: z.string(),
});

export function handleCreateVault(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const body = await request.json();
    const parsed = CreateVaultSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    const agent = getAgent(parsed.data.agent_id);
    if (!agent) throw notFound(`agent not found: ${parsed.data.agent_id}`);

    // Check for duplicate vault name on same agent
    const existing = listVaults({ agent_id: parsed.data.agent_id });
    if (existing.some(v => v.name === parsed.data.name)) {
      throw conflict(`Vault "${parsed.data.name}" already exists for this agent`);
    }

    const vault = createVault({
      agent_id: parsed.data.agent_id,
      name: parsed.data.name,
    });
    return jsonOk(vault, 201);
  });
}

export function handleListVaults(request: Request): Promise<Response> {
  return routeWrap(request, async ({ request: req }) => {
    const url = new URL(req.url);
    const agentId = url.searchParams.get("agent_id") ?? undefined;
    const data = listVaults({ agent_id: agentId });
    return jsonOk({ data });
  });
}

export function handleGetVault(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    const vault = getVault(id);
    if (!vault) throw notFound(`vault not found: ${id}`);
    return jsonOk(vault);
  });
}

export function handleDeleteVault(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    const deleted = deleteVault(id);
    if (!deleted) throw notFound(`vault not found: ${id}`);
    return jsonOk({ id, type: "vault_deleted" });
  });
}

export function handleListEntries(request: Request, vaultId: string): Promise<Response> {
  return routeWrap(request, async () => {
    const vault = getVault(vaultId);
    if (!vault) throw notFound(`vault not found: ${vaultId}`);
    // Return keys with masked values — never expose plaintext via list API
    const entries = listEntries(vaultId);
    const data = entries.map(e => ({ key: e.key, value: maskValue(e.value) }));
    return jsonOk({ data });
  });
}

export function handleGetEntry(request: Request, vaultId: string, key: string): Promise<Response> {
  return routeWrap(request, async () => {
    const vault = getVault(vaultId);
    if (!vault) throw notFound(`vault not found: ${vaultId}`);
    const entry = getEntry(vaultId, key);
    if (!entry) throw notFound(`entry not found: ${key}`);
    // Mask value — plaintext is only available to server-side consumers (driver, sync)
    return jsonOk({ key: entry.key, value: maskValue(entry.value) });
  });
}

export function handlePutEntry(request: Request, vaultId: string, key: string): Promise<Response> {
  return routeWrap(request, async () => {
    const vault = getVault(vaultId);
    if (!vault) throw notFound(`vault not found: ${vaultId}`);

    const body = await request.json();
    const parsed = PutEntrySchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error.message);

    setEntry(vaultId, key, parsed.data.value);
    return jsonOk({ key, ok: true });
  });
}

export function handleDeleteEntry(request: Request, vaultId: string, key: string): Promise<Response> {
  return routeWrap(request, async () => {
    const vault = getVault(vaultId);
    if (!vault) throw notFound(`vault not found: ${vaultId}`);
    const deleted = deleteEntry(vaultId, key);
    if (!deleted) throw notFound(`entry not found: ${key}`);
    return jsonOk({ key, type: "entry_deleted" });
  });
}
