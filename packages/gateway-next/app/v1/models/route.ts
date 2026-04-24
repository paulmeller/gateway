import { handleListModels } from "@agentstep/agent-sdk/handlers";

export async function GET(req: Request) { return handleListModels(req); }
