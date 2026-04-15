import { handleGetEnvironment, handleDeleteEnvironment } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: P) { return handleGetEnvironment(_req, (await params).id); }
export async function DELETE(_req: Request, { params }: P) { return handleDeleteEnvironment(_req, (await params).id); }
