import { handleCreateSession, handleListSessions } from "@agentstep/agent-sdk/handlers";

export async function POST(req: Request) { return handleCreateSession(req); }
export async function GET(req: Request) { return handleListSessions(req); }
