import { handleListThreads } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: P) { return handleListThreads(_req, (await params).id); }
