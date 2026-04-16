/**
 * Backend interface — commands call these methods without knowing
 * whether they're talking to a local SQLite DB or a remote HTTP server.
 */

export interface Paginated<T> {
  data: T[];
  next_page: string | null;
}

export interface AgentBackend {
  create(input: { name: string; model: string; system?: string; backend?: string; confirmation_mode?: boolean }): Promise<any>;
  list(opts?: { limit?: number; order?: string; include_archived?: boolean }): Promise<Paginated<any>>;
  get(id: string, version?: number): Promise<any>;
  update(id: string, input: Record<string, unknown>): Promise<any>;
  delete(id: string): Promise<{ id: string; type: string }>;
}

export interface EnvBackend {
  create(input: { name: string; config: Record<string, unknown> }): Promise<any>;
  list(opts?: { limit?: number; order?: string; include_archived?: boolean }): Promise<Paginated<any>>;
  get(id: string): Promise<any>;
  delete(id: string): Promise<{ id: string; type: string }>;
  archive(id: string): Promise<any>;
}

export interface SessionBackend {
  create(input: { agent: string | { id: string; version: number; type?: string }; environment_id: string; title?: string; max_budget_usd?: number }): Promise<any>;
  list(opts?: { limit?: number; order?: string; agent_id?: string; environment_id?: string; status?: string; include_archived?: boolean }): Promise<Paginated<any>>;
  get(id: string): Promise<any>;
  update(id: string, input: Record<string, unknown>): Promise<any>;
  delete(id: string): Promise<{ id: string; type: string }>;
  archive(id: string): Promise<any>;
  threads(id: string, opts?: { limit?: number }): Promise<Paginated<any>>;
}

export interface EventBackend {
  send(sessionId: string, events: Array<Record<string, unknown>>): Promise<{ events: any[] }>;
  list(sessionId: string, opts?: { limit?: number; order?: string; after_seq?: number }): Promise<Paginated<any>>;
  stream(sessionId: string, afterSeq?: number): AsyncIterable<any>;
}

export interface VaultBackend {
  create(input: { agent_id: string; name: string }): Promise<any>;
  list(opts?: { agent_id?: string }): Promise<{ data: any[] }>;
  get(id: string): Promise<any>;
  delete(id: string): Promise<{ id: string; type: string }>;
  entries: {
    list(vaultId: string): Promise<{ data: any[] }>;
    get(vaultId: string, key: string): Promise<any>;
    set(vaultId: string, key: string, value: string): Promise<any>;
    delete(vaultId: string, key: string): Promise<{ key: string; type: string }>;
  };
}

export interface MemoryBackend {
  stores: {
    create(input: { name: string; description?: string }): Promise<any>;
    list(): Promise<{ data: any[] }>;
    get(id: string): Promise<any>;
    delete(id: string): Promise<{ id: string; type: string }>;
  };
  memories: {
    create(storeId: string, input: { path: string; content: string }): Promise<any>;
    list(storeId: string): Promise<{ data: any[] }>;
    get(storeId: string, memId: string): Promise<any>;
    update(storeId: string, memId: string, input: { content: string; content_sha256?: string }): Promise<any>;
    delete(storeId: string, memId: string): Promise<{ id: string; type: string }>;
  };
}

export interface BatchBackend {
  execute(operations: Array<{ method: string; path: string; body?: unknown }>): Promise<{ results: Array<{ status: number; body: unknown }> }>;
}

export interface SkillsBackend {
  search(opts: { q?: string; sort?: string; limit?: number; offset?: number; source?: string }): Promise<any>;
  stats(): Promise<any>;
  sources(opts?: { limit?: number }): Promise<any>;
}

export interface ProvidersBackend {
  status(): Promise<Record<string, { available: boolean; message?: string }>>;
}

export interface Backend {
  init(): Promise<void>;
  agents: AgentBackend;
  environments: EnvBackend;
  sessions: SessionBackend;
  events: EventBackend;
  vaults: VaultBackend;
  memory: MemoryBackend;
  batch: BatchBackend;
  skills: SkillsBackend;
  providers: ProvidersBackend;
}
