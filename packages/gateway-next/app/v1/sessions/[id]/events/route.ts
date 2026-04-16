import { handlePostEvents, handleListEvents } from "@agentstep/agent-sdk/handlers";

type P = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: P) { return handlePostEvents(_req, (await params).id); }
export async function GET(_req: Request, { params }: P) { return handleListEvents(_req, (await params).id); }
