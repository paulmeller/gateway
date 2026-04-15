/**
 * Batch operations: execute multiple resource mutations in a single
 * SQLite transaction. All operations succeed or all fail.
 */
import { getDb } from "./client";
import { createAgent, archiveAgent } from "./agents";
import { createEnvironment, deleteEnvironment } from "./environments";
import { createSession } from "./sessions";
import { getAgent } from "./agents";
import { getEnvironment } from "./environments";
import type { EnvironmentConfig } from "../types";

export interface BatchOp {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

export interface BatchResult {
  status: number;
  body: unknown;
}

/**
 * Execute a batch of operations in a single transaction.
 * On any error, the transaction rolls back and the error is returned
 * for the failed operation.
 */
export function executeBatch(operations: BatchOp[]): BatchResult[] {
  const db = getDb();

  return db.transaction(() => {
    const results: BatchResult[] = [];

    for (const op of operations) {
      try {
        const result = executeSingleOp(op);
        results.push(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Re-throw to trigger transaction rollback
        throw new BatchError(results.length, msg, results);
      }
    }

    return results;
  })();
}

export class BatchError extends Error {
  constructor(
    public readonly failedIndex: number,
    message: string,
    public readonly partialResults: BatchResult[],
  ) {
    super(message);
    this.name = "BatchError";
  }
}

function executeSingleOp(op: BatchOp): BatchResult {
  const { method, path, body } = op;
  const upperMethod = method.toUpperCase();

  // POST /v1/agents
  if (upperMethod === "POST" && path === "/v1/agents") {
    if (!body?.name || !body?.model) {
      throw new Error("agent creation requires name and model");
    }
    const agent = createAgent({
      name: body.name as string,
      model: body.model as string,
      system: (body.system as string) ?? null,
      tools: (body.tools as []) ?? [],
      mcp_servers: (body.mcp_servers as Record<string, never>) ?? {},
      backend: (body.backend as "claude") ?? "claude",
      webhook_url: (body.webhook_url as string) ?? null,
      webhook_events: body.webhook_events as string[] | undefined,
      threads_enabled: (body.threads_enabled as boolean) ?? false,
    });
    return { status: 201, body: agent };
  }

  // POST /v1/environments
  if (upperMethod === "POST" && path === "/v1/environments") {
    if (!body?.name || !body?.config) {
      throw new Error("environment creation requires name and config");
    }
    const env = createEnvironment({
      name: body.name as string,
      config: body.config as EnvironmentConfig,
    });
    return { status: 201, body: env };
  }

  // POST /v1/sessions
  if (upperMethod === "POST" && path === "/v1/sessions") {
    if (!body?.agent || !body?.environment_id) {
      throw new Error("session creation requires agent and environment_id");
    }
    const agentRef = body.agent as string | { id: string; version: number };
    const agentId = typeof agentRef === "string" ? agentRef : agentRef.id;
    const agentVersion = typeof agentRef === "string" ? undefined : agentRef.version;

    const agent = getAgent(agentId, agentVersion);
    if (!agent) throw new Error(`agent not found: ${agentId}`);

    const env = getEnvironment(body.environment_id as string);
    if (!env) throw new Error(`environment not found: ${body.environment_id}`);

    const session = createSession({
      agent_id: agent.id,
      agent_version: agent.version,
      environment_id: env.id,
      title: (body.title as string) ?? null,
      metadata: (body.metadata as Record<string, unknown>) ?? {},
      max_budget_usd: (body.max_budget_usd as number) ?? null,
      vault_ids: (body.vault_ids as string[]) ?? null,
    });
    return { status: 201, body: session };
  }

  // DELETE /v1/agents/{id}
  const agentDeleteMatch = path.match(/^\/v1\/agents\/([^/]+)$/);
  if (upperMethod === "DELETE" && agentDeleteMatch) {
    const id = agentDeleteMatch[1];
    const archived = archiveAgent(id);
    if (!archived) throw new Error(`agent not found: ${id}`);
    return { status: 200, body: { id, type: "agent_deleted" } };
  }

  // DELETE /v1/environments/{id}
  const envDeleteMatch = path.match(/^\/v1\/environments\/([^/]+)$/);
  if (upperMethod === "DELETE" && envDeleteMatch) {
    const id = envDeleteMatch[1];
    const deleted = deleteEnvironment(id);
    if (!deleted) throw new Error(`environment not found: ${id}`);
    return { status: 200, body: { id, type: "environment_deleted" } };
  }

  throw new Error(`unsupported batch operation: ${method} ${path}`);
}
