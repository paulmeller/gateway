/**
 * LocalBackend — imports @agentstep/agent-sdk directly.
 * No HTTP, no auth, direct DB/bus access.
 */
import type { Backend, Paginated } from "./interface.js";
import { initForCli } from "../lifecycle.js";

export class LocalBackend implements Backend {
  async init(): Promise<void> {
    await initForCli();
  }

  agents = {
    async create(input: { name: string; model: string; system?: string; backend?: string; confirmation_mode?: boolean }) {
      const { createAgent } = await import("@agentstep/agent-sdk");
      return createAgent({
        name: input.name,
        model: input.model,
        system: input.system ?? null,
        backend: (input.backend as any) ?? "claude",
        confirmation_mode: input.confirmation_mode ?? false,
      });
    },

    async list(opts?: { limit?: number; order?: string; include_archived?: boolean }): Promise<Paginated<any>> {
      const { listAgents } = await import("@agentstep/agent-sdk");
      const data = listAgents({
        limit: opts?.limit ?? 20,
        order: (opts?.order as "asc" | "desc") ?? "desc",
        includeArchived: opts?.include_archived ?? false,
      });
      return { data, next_page: data.length > 0 ? data[data.length - 1].id : null };
    },

    async get(id: string, version?: number) {
      const { getAgent } = await import("@agentstep/agent-sdk");
      const agent = getAgent(id, version);
      if (!agent) throw new Error(`Agent ${id} not found`);
      return agent;
    },

    async update(id: string, input: Record<string, unknown>) {
      const { updateAgent } = await import("@agentstep/agent-sdk");
      return updateAgent(id, input as any);
    },

    async delete(id: string) {
      const { archiveAgent } = await import("@agentstep/agent-sdk");
      archiveAgent(id);
      return { id, type: "agent_deleted" };
    },
  };

  environments = {
    async create(input: { name: string; config: Record<string, unknown> }) {
      const { createEnvironment, kickoffEnvironmentSetup } = await import("@agentstep/agent-sdk");
      const env = createEnvironment({ name: input.name, config: input.config as any });
      void kickoffEnvironmentSetup(env.id).catch((err: unknown) => {
        console.error(`[cli] environment setup failed:`, err);
      });
      return env;
    },

    async list(opts?: { limit?: number; order?: string; include_archived?: boolean }): Promise<Paginated<any>> {
      const { listEnvironments } = await import("@agentstep/agent-sdk");
      const data = listEnvironments({
        limit: opts?.limit ?? 20,
        order: (opts?.order as "asc" | "desc") ?? "desc",
        includeArchived: opts?.include_archived ?? false,
      });
      return { data, next_page: data.length > 0 ? data[data.length - 1].id : null };
    },

    async get(id: string) {
      const { getEnvironment } = await import("@agentstep/agent-sdk");
      const env = getEnvironment(id);
      if (!env) throw new Error(`Environment ${id} not found`);
      return env;
    },

    async delete(id: string) {
      const { deleteEnvironment } = await import("@agentstep/agent-sdk");
      deleteEnvironment(id);
      return { id, type: "environment_deleted" };
    },

    async archive(id: string) {
      const { archiveEnvironment, getEnvironment } = await import("@agentstep/agent-sdk");
      archiveEnvironment(id);
      return getEnvironment(id);
    },
  };

  sessions = {
    async create(input: { agent: string | { id: string; version: number; type?: string }; environment_id: string; title?: string; max_budget_usd?: number }) {
      const { createSession, getAgent } = await import("@agentstep/agent-sdk");
      let agentId: string;
      let agentVersion: number;

      if (typeof input.agent === "string") {
        const agent = getAgent(input.agent);
        if (!agent) throw new Error(`Agent ${input.agent} not found`);
        agentId = agent.id;
        agentVersion = agent.version;
      } else {
        agentId = input.agent.id;
        agentVersion = input.agent.version;
      }

      return createSession({
        agent_id: agentId,
        agent_version: agentVersion,
        environment_id: input.environment_id,
        title: input.title ?? null,
        max_budget_usd: input.max_budget_usd ?? null,
      });
    },

    async list(opts?: { limit?: number; order?: string; agent_id?: string; environment_id?: string; status?: string; include_archived?: boolean }): Promise<Paginated<any>> {
      const { listSessions } = await import("@agentstep/agent-sdk");
      const data = listSessions({
        limit: opts?.limit ?? 20,
        order: (opts?.order as "asc" | "desc") ?? "desc",
        agent_id: opts?.agent_id,
        environmentId: opts?.environment_id,
        status: opts?.status as any,
        includeArchived: opts?.include_archived ?? false,
      });
      return { data, next_page: data.length > 0 ? data[data.length - 1].id : null };
    },

    async get(id: string) {
      const { getSession } = await import("@agentstep/agent-sdk");
      const session = getSession(id);
      if (!session) throw new Error(`Session ${id} not found`);
      return session;
    },

    async update(id: string, input: Record<string, unknown>) {
      const { updateSessionMutable, getSession } = await import("@agentstep/agent-sdk");
      updateSessionMutable(id, input as any);
      return getSession(id);
    },

    async delete(id: string) {
      const {
        getSession, getActor, interruptSession, releaseSession,
        appendEvent, dropActor, dropEmitter, nowMs,
      } = await import("@agentstep/agent-sdk");
      const { updateSessionStatus } = await import("@agentstep/agent-sdk/db/sessions");

      const session = getSession(id);
      if (!session) throw new Error(`Session ${id} not found`);

      // Replicate handleDeleteSession: serialize through actor
      const actor = getActor(id);
      await actor.enqueue(async () => {
        interruptSession(id);
        await releaseSession(id);
        appendEvent(id, {
          type: "session.status_terminated",
          payload: { reason: "deleted" },
          origin: "server",
          processedAt: nowMs(),
        });
        updateSessionStatus(id, "terminated", "deleted");
      });
      dropActor(id);
      dropEmitter(id);

      return { id, type: "session_deleted" };
    },

    async archive(id: string) {
      const { archiveSession, getSession } = await import("@agentstep/agent-sdk");
      archiveSession(id);
      return getSession(id);
    },

    async threads(id: string, opts?: { limit?: number }): Promise<Paginated<any>> {
      const { listSessions } = await import("@agentstep/agent-sdk");
      const data = listSessions({
        parent_session_id: id,
        limit: opts?.limit ?? 20,
      });
      return { data, next_page: data.length > 0 ? data[data.length - 1].id : null };
    },
  };

  events = {
    async send(sessionId: string, events: Array<Record<string, unknown>>) {
      const {
        getSession, getAgent, getSessionRow, getActor,
        appendEvent, interruptSession, pushPendingUserInput,
        enqueueTurn, runTurn, writePermissionResponse,
        setOutcomeCriteria, isProxied, rowToManagedEvent,
      } = await import("@agentstep/agent-sdk");
      type TurnInput = import("@agentstep/agent-sdk").TurnInput;

      const session = getSession(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);

      if (isProxied(sessionId)) {
        throw new Error("Cannot send events to a proxied session in local mode. Use --remote.");
      }

      // Pre-validate tool_confirmation
      for (const evt of events) {
        if (evt.type === "user.tool_confirmation") {
          const agent = getAgent(session.agent.id, session.agent.version);
          if (!agent?.confirmation_mode) {
            throw new Error("user.tool_confirmation not supported: agent does not have confirmation_mode enabled.");
          }
        }
      }

      // Interrupt eagerly (outside actor)
      const hasInterrupt = events.some((e) => e.type === "user.interrupt");
      if (hasInterrupt) interruptSession(sessionId);

      const actor = getActor(sessionId);

      const appended = await actor.enqueue(async () => {
        const rows: any[] = [];
        const pendingForTurn: TurnInput[] = [];
        let sawInterrupt = false;

        for (const event of events) {
          if (event.type === "user.interrupt") {
            const row = appendEvent(sessionId, {
              type: "user.interrupt", payload: {}, origin: "user",
              idempotencyKey: null, processedAt: Date.now(),
            });
            rows.push(row);
            sawInterrupt = true;
            continue;
          }

          if (event.type === "user.message") {
            const content = event.content as Array<{ type: string; text: string }>;
            const text = content.map((b) => b.text).join("");
            const row = appendEvent(sessionId, {
              type: "user.message", payload: { content },
              origin: "user", idempotencyKey: null, processedAt: null,
            });
            rows.push(row);

            const inp: TurnInput = { kind: "text", eventId: row.id, text };
            const status = getSessionRow(sessionId)?.status ?? "idle";
            if (status === "running" || sawInterrupt) {
              pushPendingUserInput({ sessionId, input: inp });
            } else {
              pendingForTurn.push(inp);
            }
            continue;
          }

          if (event.type === "user.tool_confirmation") {
            const result = (event.result as string) ?? "allow";
            const row = appendEvent(sessionId, {
              type: "user.tool_confirmation",
              payload: {
                tool_use_id: event.tool_use_id ?? null,
                result,
                deny_message: event.deny_message ?? null,
              },
              origin: "user", idempotencyKey: null, processedAt: Date.now(),
            });
            rows.push(row);
            void writePermissionResponse(sessionId, result, event.deny_message as string | undefined).catch(() => {});
            continue;
          }

          if (event.type === "user.custom_tool_result") {
            const row = appendEvent(sessionId, {
              type: "user.custom_tool_result",
              payload: { custom_tool_use_id: event.custom_tool_use_id, content: event.content },
              origin: "user", idempotencyKey: null, processedAt: Date.now(),
            });
            rows.push(row);

            const inp: TurnInput = {
              kind: "tool_result", eventId: row.id,
              custom_tool_use_id: event.custom_tool_use_id as string,
              content: event.content as unknown[],
            };
            const status = getSessionRow(sessionId)?.status ?? "idle";
            if (status === "running" || sawInterrupt) {
              pushPendingUserInput({ sessionId, input: inp });
            } else {
              pendingForTurn.push(inp);
            }
            continue;
          }

          if (event.type === "user.define_outcome") {
            const { type: _, ...criteria } = event;
            const row = appendEvent(sessionId, {
              type: "user.define_outcome", payload: criteria,
              origin: "user", idempotencyKey: null, processedAt: Date.now(),
            });
            rows.push(row);
            setOutcomeCriteria(sessionId, criteria as any);
            continue;
          }
        }

        return { rows, pendingForTurn };
      });

      if (appended.pendingForTurn.length > 0) {
        const row = getSessionRow(sessionId);
        if (row) {
          void enqueueTurn(row.environment_id, () => runTurn(sessionId, appended.pendingForTurn)).catch(
            (err: unknown) => console.error(`[cli] enqueueTurn failed:`, err),
          );
        }
      }

      return { events: appended.rows.map(rowToManagedEvent) };
    },

    async list(sessionId: string, opts?: { limit?: number; order?: string; after_seq?: number }): Promise<Paginated<any>> {
      const { listEvents, rowToManagedEvent } = await import("@agentstep/agent-sdk");
      const rows = listEvents(sessionId, {
        limit: opts?.limit ?? 50,
        order: (opts?.order as "asc" | "desc") ?? "asc",
        afterSeq: opts?.after_seq ?? 0,
      });
      return {
        data: rows.map(rowToManagedEvent),
        next_page: rows.length > 0 ? String(rows[rows.length - 1].seq) : null,
      };
    },

    async *stream(sessionId: string, afterSeq?: number): AsyncGenerator<any> {
      const { subscribe } = await import("@agentstep/agent-sdk");
      const queue: any[] = [];
      let resolve: (() => void) | null = null;

      const sub = subscribe(sessionId, afterSeq ?? 0, (evt: any) => {
        queue.push(evt);
        if (resolve) { resolve(); resolve = null; }
      });

      try {
        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          await new Promise<void>((r) => { resolve = r; });
        }
      } finally {
        sub.unsubscribe();
      }
    },
  };

  vaults = {
    async create(input: { agent_id: string; name: string }) {
      const { createVault } = await import("@agentstep/agent-sdk");
      return createVault(input);
    },
    async list(opts?: { agent_id?: string }) {
      const { listVaults } = await import("@agentstep/agent-sdk");
      return { data: listVaults(opts?.agent_id) };
    },
    async get(id: string) {
      const { getVault } = await import("@agentstep/agent-sdk");
      const v = getVault(id);
      if (!v) throw new Error(`Vault ${id} not found`);
      return v;
    },
    async delete(id: string) {
      const { deleteVault } = await import("@agentstep/agent-sdk");
      deleteVault(id);
      return { id, type: "vault_deleted" };
    },
    entries: {
      async list(vaultId: string) {
        const { listEntries } = await import("@agentstep/agent-sdk");
        return { data: listEntries(vaultId) };
      },
      async get(vaultId: string, key: string) {
        const { getEntry } = await import("@agentstep/agent-sdk");
        const e = getEntry(vaultId, key);
        if (!e) throw new Error(`Entry ${key} not found in vault ${vaultId}`);
        return e;
      },
      async set(vaultId: string, key: string, value: string) {
        const { setEntry } = await import("@agentstep/agent-sdk");
        return setEntry(vaultId, key, value);
      },
      async delete(vaultId: string, key: string) {
        const { deleteEntry } = await import("@agentstep/agent-sdk");
        deleteEntry(vaultId, key);
        return { key, type: "entry_deleted" };
      },
    },
  };

  memory = {
    stores: {
      async create(input: { name: string; description?: string }) {
        const { createMemoryStore } = await import("@agentstep/agent-sdk");
        return createMemoryStore(input);
      },
      async list() {
        const { listMemoryStores } = await import("@agentstep/agent-sdk");
        return { data: listMemoryStores() };
      },
      async get(id: string) {
        const { getMemoryStore } = await import("@agentstep/agent-sdk");
        const s = getMemoryStore(id);
        if (!s) throw new Error(`Memory store ${id} not found`);
        return s;
      },
      async delete(id: string) {
        const { deleteMemoryStore } = await import("@agentstep/agent-sdk");
        deleteMemoryStore(id);
        return { id, type: "memory_store_deleted" };
      },
    },
    memories: {
      async create(storeId: string, input: { path: string; content: string }) {
        const { createOrUpsertMemory } = await import("@agentstep/agent-sdk");
        return createOrUpsertMemory(storeId, input.path, input.content);
      },
      async list(storeId: string) {
        const { listMemories } = await import("@agentstep/agent-sdk");
        return { data: listMemories(storeId) };
      },
      async get(storeId: string, memId: string) {
        const { getMemory } = await import("@agentstep/agent-sdk");
        const m = getMemory(memId);
        if (!m) throw new Error(`Memory ${memId} not found`);
        return m;
      },
      async update(storeId: string, memId: string, input: { content: string; content_sha256?: string }) {
        const { updateMemory } = await import("@agentstep/agent-sdk");
        return updateMemory(memId, input.content, input.content_sha256);
      },
      async delete(storeId: string, memId: string) {
        const { deleteMemory } = await import("@agentstep/agent-sdk");
        deleteMemory(memId);
        return { id: memId, type: "memory_deleted" };
      },
    },
  };

  batch = {
    async execute(operations: Array<{ method: string; path: string; body?: unknown }>) {
      const { executeBatch } = await import("@agentstep/agent-sdk");
      return executeBatch(operations as any);
    },
  };
}
