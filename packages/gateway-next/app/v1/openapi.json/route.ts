import { handleGetOpenApiSpec } from "@agentstep/agent-sdk/handlers";

export async function GET(req: Request) { return handleGetOpenApiSpec(req); }
