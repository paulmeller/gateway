import { handleCreateMemory, handleListMemories } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: P) { return handleCreateMemory(_req, (await params).id); }
export async function GET(_req: Request, { params }: P) { return handleListMemories(_req, (await params).id); }
