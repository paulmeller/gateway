import { handleGetAgent, handleUpdateAgent, handleDeleteAgent } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: P) { return handleGetAgent(_req, (await params).id); }
export async function POST(_req: Request, { params }: P) { return handleUpdateAgent(_req, (await params).id); }
export async function DELETE(_req: Request, { params }: P) { return handleDeleteAgent(_req, (await params).id); }
