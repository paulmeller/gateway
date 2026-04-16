import { handleCreateEnvironment, handleListEnvironments } from "@agentstep/agent-sdk/handlers";

export async function POST(req: Request) { return handleCreateEnvironment(req); }
export async function GET(req: Request) { return handleListEnvironments(req); }
