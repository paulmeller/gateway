import { z } from "zod";
import { routeWrap, jsonOk } from "../http";
import { createVault, getVault, deleteVault, listVaults, listEntries, getEntry, setEntry, deleteEntry } from "../db/vaults";
import { getAgent } from "../db/agents";
import { badRequest, notFound } from "../errors";

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
    const data = listEntries(vaultId);
    return jsonOk({ data });
  });
}

export function handleGetEntry(request: Request, vaultId: string, key: string): Promise<Response> {
  return routeWrap(request, async () => {
    const vault = getVault(vaultId);
    if (!vault) throw notFound(`vault not found: ${vaultId}`);
    const entry = getEntry(vaultId, key);
    if (!entry) throw notFound(`entry not found: ${key}`);
    return jsonOk(entry);
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
    return jsonOk({ key, value: parsed.data.value });
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
