import { handleGetVault, handleDeleteVault } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: P) { return handleGetVault(_req, (await params).id); }
export async function DELETE(_req: Request, { params }: P) { return handleDeleteVault(_req, (await params).id); }
