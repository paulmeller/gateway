import { handleGetSession, handleUpdateSession, handleDeleteSession, handleArchiveSession } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: P) { return handleGetSession(_req, (await params).id); }
export async function POST(_req: Request, { params }: P) { return handleUpdateSession(_req, (await params).id); }
export async function DELETE(_req: Request, { params }: P) { return handleDeleteSession(_req, (await params).id); }
