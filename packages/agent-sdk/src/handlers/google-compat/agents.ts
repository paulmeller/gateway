/**
 * Google Agents API compatibility layer.
 *
 * POST   /google/v1beta/agents
 * GET    /google/v1beta/agents
 * GET    /google/v1beta/agents/:id
 * DELETE /google/v1beta/agents/:id
 */
import { z } from "zod";
import { routeWrap, jsonOk } from "../../http";
import { badRequest, notFound } from "../../errors";

const SourceSchema = z.object({
  type: z.string().optional(),
  target: z.string().optional(),
  content: z.string().optional(),
  url: z.string().optional(),
}).passthrough();

const BaseEnvironmentSchema = z.object({
  type: z.string().optional(),
  sources: z.array(SourceSchema).optional(),
}).passthrough();

const CreateGoogleAgentSchema = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  base_agent: z.string().optional(),
  system_instruction: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  base_environment: BaseEnvironmentSchema.optional(),
});

interface GoogleAgentResponse {
  id: string;
  base_agent?: string;
  system_instruction?: string;
  description?: string;
  created: string;
  updated: string;
}

/**
 * Map a base_agent string to engine + model.
 */
function resolveBaseAgent(baseAgent?: string): { engine: string; model: string } {
  if (!baseAgent) return { engine: "gemini", model: "gemini-2.5-flash" };

  if (baseAgent === "antigravity-preview-05-2026") {
    return { engine: "gemini", model: "gemini-2.5-flash" };
  }
  // Default: treat as gemini engine, use the base_agent string as the model
  return { engine: "gemini", model: baseAgent };
}

/**
 * Convert our internal agent format to Google agent format.
 */
function toGoogleFormat(agent: any): GoogleAgentResponse {
  return {
    id: agent.name,
    base_agent: agent.engine === "gemini" ? "antigravity-preview-05-2026" : undefined,
    system_instruction: agent.system ?? undefined,
    description: agent.description ?? undefined,
    created: agent.created_at ?? new Date().toISOString(),
    updated: agent.updated_at ?? agent.created_at ?? new Date().toISOString(),
  };
}

// ─── POST /google/v1beta/agents ─────────────────────────────────────────────

export function handleCreateGoogleAgent(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const body = await request.json().catch(() => null);
    const parsed = CreateGoogleAgentSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(`invalid body: ${parsed.error.issues.map(i => i.message).join("; ")}`);
    }
    const data = parsed.data;

    const { engine, model } = resolveBaseAgent(data.base_agent);

    // Build system instruction from explicit field + AGENTS.md source
    let systemInstruction = data.system_instruction ?? "";
    const skills: Array<{ name: string; source: string; content: string }> = [];

    if (data.base_environment?.sources) {
      for (const source of data.base_environment.sources) {
        const target = source.target ?? "";
        // Check if it's a skill source
        const skillMatch = target.match(/\.agents\/skills\/([^/]+)\/SKILL\.md$/);
        if (skillMatch && source.content) {
          skills.push({
            name: skillMatch[1],
            source: "inline",
            content: source.content,
          });
        }
        // Check if it's AGENTS.md
        else if (target.endsWith(".agents/AGENTS.md") && source.content) {
          if (systemInstruction) systemInstruction += "\n\n";
          systemInstruction += source.content;
        }
      }
    }

    const agentName = data.id || `google-agent-${Date.now()}`;

    // Create internal agent
    const { handleCreateAgent } = await import("../anthropic-compat/agents");
    const createBody: Record<string, unknown> = {
      name: agentName,
      model: { id: model },
      engine,
    };
    if (systemInstruction) createBody.system = systemInstruction;
    if (data.description) createBody.description = data.description;
    if (skills.length > 0) createBody.skills = skills;

    const createReq = new Request(request.url.replace(/\/google\/v1beta\/agents.*/, `/v1/agents`), {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(createBody),
    });
    const createRes = await handleCreateAgent(createReq);
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({})) as Record<string, unknown>;
      throw badRequest((err as any).error?.message || `failed to create agent: ${createRes.status}`);
    }
    const created = await createRes.json() as any;

    const response: GoogleAgentResponse = {
      id: created.name ?? agentName,
      base_agent: data.base_agent,
      system_instruction: systemInstruction || undefined,
      description: data.description,
      created: created.created_at ?? new Date().toISOString(),
      updated: created.updated_at ?? created.created_at ?? new Date().toISOString(),
    };
    return jsonOk(response, 201);
  });
}

// ─── GET /google/v1beta/agents ──────────────────────────────────────────────

export function handleListGoogleAgents(request: Request): Promise<Response> {
  return routeWrap(request, async () => {
    const { handleListAgents } = await import("../anthropic-compat/agents");
    const listReq = new Request(request.url.replace(/\/google\/v1beta\/agents.*/, `/v1/agents?limit=1000`), {
      headers: request.headers,
    });
    const listRes = await handleListAgents(listReq);
    if (!listRes.ok) {
      return listRes;
    }
    const listBody = await listRes.json() as { data: any[] };
    const agents = (listBody.data ?? []).map(toGoogleFormat);
    return jsonOk({ agents });
  });
}

// ─── GET /google/v1beta/agents/:id ──────────────────────────────────────────

export function handleGetGoogleAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    const { handleListAgents } = await import("../anthropic-compat/agents");
    // Look up by name (Google uses name as ID)
    const listReq = new Request(request.url.replace(/\/google\/v1beta\/agents.*/, `/v1/agents?limit=1000`), {
      headers: request.headers,
    });
    const listRes = await handleListAgents(listReq);
    if (!listRes.ok) {
      return listRes;
    }
    const listBody = await listRes.json() as { data: any[] };
    const agent = listBody.data?.find((a: any) => a.name === id);
    if (!agent) throw notFound(`agent not found: ${id}`);

    return jsonOk(toGoogleFormat(agent));
  });
}

// ─── DELETE /google/v1beta/agents/:id ───────────────────────────────────────

export function handleDeleteGoogleAgent(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    const { handleListAgents, handleDeleteAgent } = await import("../anthropic-compat/agents");
    // Look up by name to get internal ID
    const listReq = new Request(request.url.replace(/\/google\/v1beta\/agents.*/, `/v1/agents?limit=1000`), {
      headers: request.headers,
    });
    const listRes = await handleListAgents(listReq);
    if (!listRes.ok) {
      return listRes;
    }
    const listBody = await listRes.json() as { data: any[] };
    const agent = listBody.data?.find((a: any) => a.name === id);
    if (!agent) throw notFound(`agent not found: ${id}`);

    // Delete via internal handler
    const delReq = new Request(request.url.replace(/\/google\/v1beta\/agents.*/, `/v1/agents/${agent.id}`), {
      method: "DELETE",
      headers: request.headers,
    });
    await handleDeleteAgent(delReq, agent.id);

    return jsonOk({});
  });
}
