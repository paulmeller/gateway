import { handleGetMemory, handleUpdateMemory, handleDeleteMemory } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string; memId: string }> };

export async function GET(_req: Request, { params }: P) { const p = await params; return handleGetMemory(_req, p.id, p.memId); }
export async function PATCH(_req: Request, { params }: P) { const p = await params; return handleUpdateMemory(_req, p.id, p.memId); }
export async function DELETE(_req: Request, { params }: P) { const p = await params; return handleDeleteMemory(_req, p.id, p.memId); }
