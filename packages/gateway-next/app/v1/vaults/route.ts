import { handleCreateVault, handleListVaults } from "@agentstep/agent-sdk/handlers";

export async function POST(req: Request) { return handleCreateVault(req); }
export async function GET(req: Request) { return handleListVaults(req); }
