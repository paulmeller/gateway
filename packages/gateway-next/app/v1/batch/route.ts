import { handleBatch } from "@agentstep/agent-sdk/handlers";

export async function POST(req: Request) { return handleBatch(req); }
