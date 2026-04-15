import { handleCreateMemoryStore, handleListMemoryStores } from "@agentstep/agent-sdk/handlers";

export async function POST(req: Request) { return handleCreateMemoryStore(req); }
export async function GET(req: Request) { return handleListMemoryStores(req); }
