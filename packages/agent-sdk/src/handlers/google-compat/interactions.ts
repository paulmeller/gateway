/**
 * POST /google/v1beta/interactions
 * GET  /google/v1beta/interactions/:id
 * DELETE /google/v1beta/interactions/:id
 * POST /google/v1beta/interactions/:id/cancel
 *
 * Translates Google Interactions API calls into our internal session primitives.
 * Creates a session, sends a message, waits for completion, returns the result.
 */
import { z } from "zod";
import { routeWrap, jsonOk } from "../../http";
import { badRequest, notFound } from "../../errors";
import { getDb } from "../../db/client";
import { newId } from "../../util/ids";
import type { InteractionResponse, InteractionStep, InteractionUsage } from "./types";
import type { ManagedEvent } from "../../types";

// DB table for interaction -> session mapping
function ensureTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_interactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'completed',
      environment_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
}

const CreateSchema = z.object({
  model: z.string().optional(),
  agent: z.string().optional(),
  input: z.union([z.string(), z.array(z.unknown())]),
  system_instruction: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  generation_config: z.record(z.unknown()).optional(),
  previous_interaction_id: z.string().optional(),
  environment: z.union([z.string(), z.object({ type: z.string() }).passthrough()]).optional(),
  stream: z.boolean().optional(),
});

export function handleCreateInteraction(request: Request): Promise<Response> {
  return routeWrap(request, async ({ auth }) => {
    ensureTable();

    const body = await request.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(`invalid body: ${parsed.error.issues.map(i => i.message).join("; ")}`);
    }
    const data = parsed.data;

    if (!data.model && !data.agent) {
      throw badRequest("either 'model' or 'agent' is required");
    }

    // Resolve input text
    const inputText = typeof data.input === "string"
      ? data.input
      : JSON.stringify(data.input);

    const { handleCreateAgent, handleListAgents } = await import("../anthropic-compat/agents");
    const { handleCreateSession } = await import("../anthropic-compat/sessions");
    const { handlePostEvents } = await import("../anthropic-compat/events");

    let agentId: string;
    let environmentId: string | undefined;

    if (data.previous_interaction_id) {
      // Multi-turn: look up existing session
      const db = getDb();
      const prev = db.prepare(
        `SELECT session_id, environment_id FROM google_interactions WHERE id = ?`
      ).get(data.previous_interaction_id) as { session_id: string; environment_id: string | null } | undefined;
      if (!prev) throw notFound(`interaction not found: ${data.previous_interaction_id}`);
      agentId = ""; // not needed for multi-turn (session already bound)
      environmentId = prev.environment_id ?? undefined;

      // Send message to existing session
      const sessionId = prev.session_id;

      // Get current highest seq before sending new events (so we skip old idle events)
      const { listEvents: listEventsForSeq } = await import("../../db/events");
      const lastEvents = listEventsForSeq(sessionId, { limit: 1, order: "desc" });
      const afterSeq = lastEvents.length > 0 ? lastEvents[0].seq : 0;

      // Check if input contains function_result items (tool call responses)
      const functionResultEvents = buildFunctionResultEvents(data.input);

      const eventsReq = new Request(request.url.replace(/\/google\/v1beta\/interactions.*/, `/v1/sessions/${sessionId}/events`), {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({
          events: functionResultEvents.length > 0
            ? functionResultEvents
            : [{ type: "user.message", content: [{ type: "text", text: inputText }] }],
        }),
      });
      const eventsRes = await handlePostEvents(eventsReq, sessionId);
      if (!eventsRes.ok) {
        const err = await eventsRes.json().catch(() => ({})) as Record<string, unknown>;
        throw badRequest((err as any).error?.message || `failed to send message: ${eventsRes.status}`);
      }

      // Wait for completion (start after current seq to skip old idle events)
      const result = await waitForCompletion(sessionId, afterSeq);

      // Store interaction
      const interactionId = `int_${newId("sesn").slice(5)}`;
      const prevSeq = db.prepare(
        `SELECT MAX(seq) as maxSeq FROM google_interactions WHERE session_id = ?`
      ).get(sessionId) as { maxSeq: number | null } | undefined;
      const seq = (prevSeq?.maxSeq ?? 0) + 1;
      db.prepare(
        `INSERT INTO google_interactions (id, session_id, seq, status, environment_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(interactionId, sessionId, seq, result.status, environmentId ?? null, new Date().toISOString());

      return jsonOk(buildResponse(interactionId, result, environmentId));
    }

    // New interaction: resolve agent
    const modelId = data.model || "gemini-2.5-flash";
    const agentName = data.agent || `auto-${modelId.replace(/[^a-z0-9-]/g, "-")}`;

    // Try to find an existing agent. Priority:
    //   1. Explicit agent name match (user passed `agent` field)
    //   2. Any agent with matching model that has vaults (can authenticate)
    //   3. Any agent with matching model (may not have vaults)
    //   4. Create a new agent
    const listReq = new Request(request.url.replace(/\/google\/v1beta\/interactions.*/, `/v1/agents?limit=1000`), {
      headers: request.headers,
    });
    const listRes = await handleListAgents(listReq);
    const listBody = await listRes.json() as { data: Array<{ id: string; name: string; model?: { id: string } }> };

    const { listVaults } = await import("../../db/vaults");
    const { tenantFilter: getTenantFilter } = await import("../../auth/scope");
    const allVaults = listVaults({ tenantFilter: getTenantFilter(auth) })
      .filter(v => !v.archived_at);

    let existing: { id: string; name: string } | undefined;
    if (data.agent) {
      // Explicit agent name — must match exactly
      existing = listBody.data?.find(a => a.name === agentName);
    } else {
      // Model-based search: find agents with this model, prefer ones with vaults
      const modelMatches = listBody.data?.filter(a => a.model?.id === modelId) ?? [];
      const withVaults = modelMatches.filter(a =>
        allVaults.some(v => v.agent_id === a.id || !v.agent_id),
      );
      // Prefer an agent that has its OWN scoped vault
      existing = modelMatches.find(a => allVaults.some(v => v.agent_id === a.id))
        ?? withVaults[0]
        ?? modelMatches[0];
    }

    if (existing) {
      agentId = existing.id;
    } else {
      // Create agent for this model
      const createReq = new Request(request.url.replace(/\/google\/v1beta\/interactions.*/, `/v1/agents`), {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({
          name: agentName,
          model: { id: modelId },
          system: data.system_instruction ?? null,
        }),
      });
      const createRes = await handleCreateAgent(createReq);
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({})) as Record<string, unknown>;
        throw badRequest((err as any).error?.message || `failed to create agent: ${createRes.status}`);
      }
      const created = await createRes.json() as { id: string };
      agentId = created.id;
    }

    // Resolve environment: use the first ready one or create one
    const { listEnvironments } = await import("../../db/environments");
    const envs = listEnvironments({ includeArchived: false, limit: 10 });
    const readyEnv = envs.find(e => e.state === "ready");
    if (readyEnv) {
      environmentId = readyEnv.id;
    } else {
      // Create a default environment directly in DB (avoid async setup)
      const { handleCreateEnvironment } = await import("../anthropic-compat/environments");
      const envReq = new Request(request.url.replace(/\/google\/v1beta\/interactions.*/, `/v1/environments`), {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ name: `google-compat-${Date.now()}` }),
      });
      const envRes = await handleCreateEnvironment(envReq);
      if (envRes.ok) {
        const envBody = await envRes.json() as { id: string };
        environmentId = envBody.id;
      }
    }

    if (!environmentId) throw badRequest("no environment available");

    // Resolve vault IDs: reuse allVaults from agent resolution above
    const vaultIds = allVaults
      .filter(v => v.agent_id === agentId || !v.agent_id)
      .map(v => v.id);

    // Create session — use agent ID as a string (handleCreateSession accepts either string or {id, version})
    const sessReq = new Request(request.url.replace(/\/google\/v1beta\/interactions.*/, `/v1/sessions`), {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({
        agent: agentId,
        environment_id: environmentId,
        ...(vaultIds.length > 0 ? { vault_ids: vaultIds } : {}),
      }),
    });
    const sessRes = await handleCreateSession(sessReq);
    if (!sessRes.ok) {
      const err = await sessRes.json().catch(() => ({})) as Record<string, unknown>;
      throw badRequest((err as any).error?.message || `failed to create session: ${sessRes.status}`);
    }
    const sessBody = await sessRes.json() as { id: string };
    const sessionId = sessBody.id;

    // Send user message
    const eventsReq = new Request(request.url.replace(/\/google\/v1beta\/interactions.*/, `/v1/sessions/${sessionId}/events`), {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: inputText }] }],
      }),
    });
    const eventsRes = await handlePostEvents(eventsReq, sessionId);
    if (!eventsRes.ok) {
      const err = await eventsRes.json().catch(() => ({})) as Record<string, unknown>;
      throw badRequest((err as any).error?.message || `failed to send message: ${eventsRes.status}`);
    }

    // Wait for session to go idle
    const result = await waitForCompletion(sessionId);

    // Store interaction mapping
    const interactionId = `int_${newId("sesn").slice(5)}`;
    const db = getDb();
    db.prepare(
      `INSERT INTO google_interactions (id, session_id, seq, status, environment_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(interactionId, sessionId, 1, result.status, environmentId ?? null, new Date().toISOString());

    return jsonOk(buildResponse(interactionId, result, environmentId));
  });
}

// ─── GET /google/v1beta/interactions/:id ─────────────────────────────────────

export function handleGetInteraction(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    ensureTable();

    const db = getDb();
    const row = db.prepare(
      `SELECT id, session_id, seq, status, environment_id, created_at FROM google_interactions WHERE id = ?`
    ).get(id) as { id: string; session_id: string; seq: number; status: string; environment_id: string | null; created_at: string } | undefined;

    if (!row) throw notFound(`interaction not found: ${id}`);

    // Rebuild steps from session events
    const { listEvents } = await import("../../db/events");
    const { rowToManagedEvent } = await import("../../db/events");
    const eventRows = listEvents(row.session_id, { limit: 500, order: "asc" });
    const steps: InteractionStep[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    for (const eventRow of eventRows) {
      const event = rowToManagedEvent(eventRow);
      if (event.type === "agent.message") {
        const content = (event as any).content as Array<{ type: string; text?: string }> | undefined;
        const text = content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";
        if (text) {
          steps.push({ type: "model_output", content: [{ type: "text", text }] });
        }
      } else if (event.type === "agent.tool_use") {
        steps.push({
          type: "function_call",
          id: (event as any).tool_use_id ?? "",
          name: (event as any).name ?? "",
          arguments: (event as any).input ?? {},
        });
      } else if (event.type === "agent.tool_result") {
        steps.push({
          type: "code_execution_result",
          call_id: (event as any).tool_use_id ?? "",
          result: JSON.stringify((event as any).content ?? ""),
        });
      } else if (event.type === "agent.custom_tool_use") {
        steps.push({
          type: "function_call",
          id: (event as any).tool_use_id ?? "",
          name: (event as any).name ?? "",
          arguments: (event as any).input ?? {},
        });
      } else if (event.type === "span.model_request_end") {
        const mu = (event as any).model_usage as { input_tokens?: number; output_tokens?: number } | undefined;
        inputTokens += mu?.input_tokens ?? 0;
        outputTokens += mu?.output_tokens ?? 0;
      }
    }

    const response: InteractionResponse = {
      id: row.id,
      created: row.created_at,
      updated: row.created_at,
      status: row.status as InteractionResponse["status"],
      steps,
      usage: { total_input_tokens: inputTokens, total_output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
      environment_id: row.environment_id ?? undefined,
    };
    return jsonOk(response);
  });
}

// ─── DELETE /google/v1beta/interactions/:id ──────────────────────────────────

export function handleDeleteInteraction(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    ensureTable();

    const db = getDb();
    const row = db.prepare(
      `SELECT id, session_id FROM google_interactions WHERE id = ?`
    ).get(id) as { id: string; session_id: string } | undefined;

    if (!row) throw notFound(`interaction not found: ${id}`);

    // Delete the interaction row
    db.prepare(`DELETE FROM google_interactions WHERE id = ?`).run(id);

    // Optionally delete the session
    const { handleDeleteSession } = await import("../anthropic-compat/sessions");
    const sessReq = new Request(request.url.replace(/\/google\/v1beta\/interactions.*/, `/v1/sessions/${row.session_id}`), {
      method: "DELETE",
      headers: request.headers,
    });
    await handleDeleteSession(sessReq, row.session_id).catch(() => {});

    return jsonOk({ id, deleted: true });
  });
}

// ─── POST /google/v1beta/interactions/:id/cancel ─────────────────────────────

export function handleCancelInteraction(request: Request, id: string): Promise<Response> {
  return routeWrap(request, async () => {
    ensureTable();

    const db = getDb();
    const row = db.prepare(
      `SELECT id, session_id, seq, status, environment_id, created_at FROM google_interactions WHERE id = ?`
    ).get(id) as { id: string; session_id: string; seq: number; status: string; environment_id: string | null; created_at: string } | undefined;

    if (!row) throw notFound(`interaction not found: ${id}`);

    // Post an interrupt event to the session
    const { handlePostEvents } = await import("../anthropic-compat/events");
    const eventsReq = new Request(request.url.replace(/\/google\/v1beta\/interactions.*/, `/v1/sessions/${row.session_id}/events`), {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({
        events: [{ type: "user.interrupt" }],
      }),
    });
    await handlePostEvents(eventsReq, row.session_id).catch(() => {});

    // Update status to cancelled
    db.prepare(`UPDATE google_interactions SET status = 'cancelled' WHERE id = ?`).run(id);

    const response: InteractionResponse = {
      id: row.id,
      created: row.created_at,
      updated: new Date().toISOString(),
      status: "cancelled",
      steps: [],
      usage: { total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0 },
      environment_id: row.environment_id ?? undefined,
    };
    return jsonOk(response);
  });
}

// --- Helpers ---

/**
 * Check if input array contains function_result items and build
 * user.custom_tool_result events for them.
 */
function buildFunctionResultEvents(input: string | unknown[]): Array<{ type: string; custom_tool_use_id: string; content: unknown[] }> {
  if (typeof input === "string") return [];
  if (!Array.isArray(input)) return [];

  const results: Array<{ type: string; custom_tool_use_id: string; content: unknown[] }> = [];
  for (const item of input) {
    if (item && typeof item === "object" && (item as any).type === "function_result") {
      const callId = (item as any).call_id ?? (item as any).id ?? "";
      const resultText = (item as any).result ?? (item as any).output ?? "";
      results.push({
        type: "user.custom_tool_result",
        custom_tool_use_id: callId,
        content: [{ type: "text", text: typeof resultText === "string" ? resultText : JSON.stringify(resultText) }],
      });
    }
  }
  return results;
}

interface CompletionResult {
  status: "completed" | "failed" | "requires_action";
  steps: InteractionStep[];
  usage: InteractionUsage;
  outputText: string;
}

async function waitForCompletion(sessionId: string, afterSeq = 0): Promise<CompletionResult> {
  const { subscribe } = await import("../../sessions/bus");

  return new Promise((resolve) => {
    const steps: InteractionStep[] = [];
    let outputText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let status: "completed" | "failed" | "requires_action" = "completed";
    let resolved = false;
    let subscription: { unsubscribe: () => void } | null = null;

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      subscription?.unsubscribe();
      resolve({
        status: "failed",
        steps,
        usage: { total_input_tokens: inputTokens, total_output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        outputText,
      });
    }, 5 * 60_000); // 5 minute timeout

    function finish() {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      subscription?.unsubscribe();
      resolve({
        status,
        steps,
        usage: { total_input_tokens: inputTokens, total_output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        outputText,
      });
    }

    function handleEvent(event: ManagedEvent) {
      if (resolved) return;

      if (event.type === "agent.message") {
        const content = (event as any).content as Array<{ type: string; text?: string }> | undefined;
        const text = content?.filter(c => c.type === "text").map(c => c.text).join("") ?? "";
        if (text) {
          outputText += text;
          steps.push({ type: "model_output", content: [{ type: "text", text }] });
        }
      } else if (event.type === "agent.tool_use") {
        steps.push({
          type: "function_call",
          id: (event as any).tool_use_id ?? "",
          name: (event as any).name ?? "",
          arguments: (event as any).input ?? {},
        });
      } else if (event.type === "agent.tool_result") {
        steps.push({
          type: "code_execution_result",
          call_id: (event as any).tool_use_id ?? "",
          result: JSON.stringify((event as any).content ?? ""),
        });
      } else if (event.type === "agent.custom_tool_use") {
        status = "requires_action";
        steps.push({
          type: "function_call",
          id: (event as any).tool_use_id ?? "",
          name: (event as any).name ?? "",
          arguments: (event as any).input ?? {},
        });
      } else if (event.type === "span.model_request_end") {
        const mu = (event as any).model_usage as { input_tokens?: number; output_tokens?: number } | undefined;
        inputTokens += mu?.input_tokens ?? 0;
        outputTokens += mu?.output_tokens ?? 0;
      } else if (event.type === "session.status_idle") {
        const stopReason = (event as any).stop_reason;
        if (stopReason === "error") status = "failed";
        else if (status !== "requires_action") status = "completed";
        finish();
      } else if (event.type === "session.error") {
        status = "failed";
      }
    }

    // Subscribe to live events starting from afterSeq (includes backlog)
    const sub = subscribe(sessionId, afterSeq, handleEvent);
    subscription = sub;

    // If we already saw an idle event in the backlog, we're done
    // (subscribe drains backlog synchronously before returning)
    if (resolved) {
      clearTimeout(timeout);
      sub.unsubscribe();
    }
  });
}

function buildResponse(id: string, result: CompletionResult, environmentId?: string): InteractionResponse {
  const now = new Date().toISOString();
  return {
    id,
    created: now,
    updated: now,
    status: result.status,
    steps: result.steps,
    usage: result.usage,
    environment_id: environmentId,
  };
}
