import { handleGetMemoryStore, handleDeleteMemoryStore } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: P) { return handleGetMemoryStore(_req, (await params).id); }
export async function DELETE(_req: Request, { params }: P) { return handleDeleteMemoryStore(_req, (await params).id); }
