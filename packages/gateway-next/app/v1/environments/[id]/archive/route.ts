import { handleArchiveEnvironment } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: P) { return handleArchiveEnvironment(_req, (await params).id); }
