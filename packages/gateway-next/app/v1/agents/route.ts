import { handleCreateAgent, handleListAgents } from "@agentstep/agent-sdk/handlers";

export async function POST(req: Request) { return handleCreateAgent(req); }
export async function GET(req: Request) { return handleListAgents(req); }
