import { handleGetEntry, handlePutEntry, handleDeleteEntry } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string; key: string }> };

export async function GET(_req: Request, { params }: P) { const p = await params; return handleGetEntry(_req, p.id, p.key); }
export async function PUT(_req: Request, { params }: P) { const p = await params; return handlePutEntry(_req, p.id, p.key); }
export async function DELETE(_req: Request, { params }: P) { const p = await params; return handleDeleteEntry(_req, p.id, p.key); }
