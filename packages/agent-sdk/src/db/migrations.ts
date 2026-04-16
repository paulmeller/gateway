import type Database from "libsql";

/**
 * Idempotent schema. All `CREATE TABLE IF NOT EXISTS`. Safe to re-run on boot.
 *
 * Schema locked per plan §Data model. Key decisions:
 *   - events is append-only with (session_id, seq) unique
 *   - processed_at is NULLABLE (set on dispatch, not on insert)
 *   - idempotency_key partial unique index dedupes client retries
 *   - stats / usage are columnar on sessions (not JSON blobs)
 *   - environments have async state machine (preparing → ready | failed)
 *   - sessions.sprite_name is NULL until first user.message (lazy reservation)
 */
export function runMigrations(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      permissions_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      type TEXT NOT NULL DEFAULT 'text',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      current_version INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS agent_versions (
      agent_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      model TEXT NOT NULL,
      system TEXT,
      tools_json TEXT NOT NULL DEFAULT '[]',
      mcp_servers_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      -- backend column added in migration below (opencode adapter); default
      -- 'claude' so existing rows and new inserts that omit it work the same
      PRIMARY KEY (agent_id, version),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'preparing',
      state_message TEXT,
      template_sprite TEXT,
      checkpoint_id TEXT,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_version INTEGER NOT NULL,
      environment_id TEXT NOT NULL,
      sprite_name TEXT,
      -- Legacy name: holds any backend's session id (claude's session_id or
      -- opencode's sessionID). Kept as claude_session_id to avoid schema
      -- churn; see lib/backends/types.ts for the abstraction.
      claude_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      stop_reason TEXT,
      title TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      turn_count INTEGER NOT NULL DEFAULT 0,
      tool_calls_count INTEGER NOT NULL DEFAULT 0,
      active_seconds REAL NOT NULL DEFAULT 0,
      duration_seconds REAL NOT NULL DEFAULT 0,
      usage_input_tokens INTEGER NOT NULL DEFAULT 0,
      usage_output_tokens INTEGER NOT NULL DEFAULT 0,
      usage_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      usage_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      usage_cost_usd REAL NOT NULL DEFAULT 0,
      last_seq INTEGER NOT NULL DEFAULT 0,
      idle_since INTEGER,
      parked_checkpoint_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      FOREIGN KEY (agent_id, agent_version) REFERENCES agent_versions(agent_id, version),
      FOREIGN KEY (environment_id) REFERENCES environments(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_env ON sessions(environment_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_created_id ON sessions(created_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      processed_at INTEGER,
      received_at INTEGER NOT NULL,
      origin TEXT NOT NULL,
      idempotency_key TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem
      ON events(session_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    -- Proxy routing table: tracks which resource IDs belong to Anthropic's
    -- hosted MA API. When isProxied(id) returns true, the route handler
    -- forwards the request to api.anthropic.com instead of handling locally.
    CREATE TABLE IF NOT EXISTS proxy_resources (
      resource_id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL CHECK(resource_type IN ('agent','environment','session')),
      created_at INTEGER NOT NULL
    );

    -- Vault persistence: per-agent key-value stores that persist across sessions.
    CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS vault_entries (
      vault_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (vault_id, key),
      FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE
    );
  `);

  // ---------------------------------------------------------------------------
  // Incremental migrations (add via PRAGMA table_info guards so re-boot is a
  // no-op on already-migrated DBs). No schema_version table exists yet; when
  // the migration count grows, introduce one and fold these into it.
  // ---------------------------------------------------------------------------

  // opencode adapter: backend discriminator on agent_versions
  const agentVersionCols = db
    .prepare(`PRAGMA table_info(agent_versions)`)
    .all() as Array<{ name: string }>;
  if (!agentVersionCols.some((c) => c.name === "backend")) {
    db.exec(
      `ALTER TABLE agent_versions ADD COLUMN backend TEXT NOT NULL DEFAULT 'claude'`,
    );
  }

  // Docker provider: provider_name on sessions (defaults to 'sprites' for existing rows)
  const sessionCols = db
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string }>;
  if (!sessionCols.some((c) => c.name === "provider_name")) {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN provider_name TEXT NOT NULL DEFAULT 'sprites'`,
    );
  }

  // Spec gap 3: max_budget_usd on sessions
  const sessionCols2 = db
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string }>;
  if (!sessionCols2.some((c) => c.name === "max_budget_usd")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN max_budget_usd REAL`);
  }

  // Spec gap 4: webhook_url + webhook_events on agent_versions
  const avCols2 = db
    .prepare(`PRAGMA table_info(agent_versions)`)
    .all() as Array<{ name: string }>;
  if (!avCols2.some((c) => c.name === "webhook_url")) {
    db.exec(`ALTER TABLE agent_versions ADD COLUMN webhook_url TEXT`);
  }
  if (!avCols2.some((c) => c.name === "webhook_events_json")) {
    db.exec(
      `ALTER TABLE agent_versions ADD COLUMN webhook_events_json TEXT NOT NULL DEFAULT '["session.status_idle","session.status_running","session.error"]'`,
    );
  }

  // Spec gap 6: outcome_criteria_json on sessions
  const sessionCols3 = db
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string }>;
  if (!sessionCols3.some((c) => c.name === "outcome_criteria_json")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN outcome_criteria_json TEXT`);
  }

  // Spec gap 7: resources_json on sessions
  const sessionCols4 = db
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string }>;
  if (!sessionCols4.some((c) => c.name === "resources_json")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN resources_json TEXT`);
  }

  // Vault persistence: vault_ids_json on sessions
  const sessionCols5 = db
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string }>;
  if (!sessionCols5.some((c) => c.name === "vault_ids_json")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN vault_ids_json TEXT`);
  }

  // Multi-agent threads: parent_session_id + thread_depth on sessions
  const sessionCols6 = db
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string }>;
  if (!sessionCols6.some((c) => c.name === "parent_session_id")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`);
  }
  if (!sessionCols6.some((c) => c.name === "thread_depth")) {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN thread_depth INTEGER NOT NULL DEFAULT 0`,
    );
  }

  // Multi-agent threads: threads_enabled on agent_versions
  const avCols3 = db
    .prepare(`PRAGMA table_info(agent_versions)`)
    .all() as Array<{ name: string }>;
  if (!avCols3.some((c) => c.name === "threads_enabled")) {
    db.exec(
      `ALTER TABLE agent_versions ADD COLUMN threads_enabled INTEGER NOT NULL DEFAULT 0`,
    );
  }

  // Tool confirmation: confirmation_mode on agent_versions
  const avCols4 = db
    .prepare(`PRAGMA table_info(agent_versions)`)
    .all() as Array<{ name: string }>;
  if (!avCols4.some((c) => c.name === "confirmation_mode")) {
    db.exec(
      `ALTER TABLE agent_versions ADD COLUMN confirmation_mode INTEGER NOT NULL DEFAULT 0`,
    );
  }

  // Memory stores
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL REFERENCES memory_stores(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(store_id, path)
    )
  `);

  // Index on parent_session_id for thread listing
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_parent
      ON sessions(parent_session_id) WHERE parent_session_id IS NOT NULL
  `);

  // callable_agents on agent_versions (for multi-agent thread config)
  const avCols5 = db
    .prepare(`PRAGMA table_info(agent_versions)`)
    .all() as Array<{ name: string }>;
  if (!avCols5.some((c) => c.name === "callable_agents_json")) {
    db.exec(
      `ALTER TABLE agent_versions ADD COLUMN callable_agents_json TEXT`,
    );
  }

  // Add skills_json column to agent_versions (idempotent)
  const avCols = db.prepare("PRAGMA table_info(agent_versions)").all() as Array<{ name: string }>;
  if (!avCols.some(c => c.name === "skills_json")) {
    db.exec("ALTER TABLE agent_versions ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Observability: trace/span columns on events
  //
  // Every event produced during a turn carries a trace_id. Span boundary
  // events (`span.*_start` / `span.*_end`) also carry span_id and the
  // parent_span_id that nests them into the trace tree. Non-span events
  // inherit the current open span via `span_id` so reconstructing the tree
  // from a trace_id is a single indexed scan.
  //
  // Trace propagation:
  //   - A fresh trace_id is minted per top-level runTurn invocation.
  //   - tool_result re-entry and grader recursion reuse the parent trace_id.
  //   - Sub-agent threads (handleSpawnAgent) inherit the parent's trace_id
  //     and nest under the parent's current span_id; the child session's
  //     events query the same trace_id for a cross-session waterfall.
  // ─────────────────────────────────────────────────────────────────────────
  const eventCols = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
  if (!eventCols.some((c) => c.name === "trace_id")) {
    db.exec(`ALTER TABLE events ADD COLUMN trace_id TEXT`);
  }
  if (!eventCols.some((c) => c.name === "span_id")) {
    db.exec(`ALTER TABLE events ADD COLUMN span_id TEXT`);
  }
  if (!eventCols.some((c) => c.name === "parent_span_id")) {
    db.exec(`ALTER TABLE events ADD COLUMN parent_span_id TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_events_trace
       ON events(trace_id) WHERE trace_id IS NOT NULL`,
  );

  // Environment description and metadata
  const envCols = db
    .prepare(`PRAGMA table_info(environments)`)
    .all() as Array<{ name: string }>;
  if (!envCols.some((c) => c.name === "description")) {
    db.exec(`ALTER TABLE environments ADD COLUMN description TEXT`);
  }
  if (!envCols.some((c) => c.name === "metadata_json")) {
    db.exec(
      `ALTER TABLE environments ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'`,
    );
  }

  // model_config: per-agent model configuration (speed, etc.)
  const avColsModelConfig = db.prepare("PRAGMA table_info(agent_versions)").all() as Array<{ name: string }>;
  if (!avColsModelConfig.some(c => c.name === "model_config_json")) {
    db.exec("ALTER TABLE agent_versions ADD COLUMN model_config_json TEXT NOT NULL DEFAULT '{}'");
  }

  // Files table for uploaded files
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      scope_type TEXT,
      scope_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // Add scope columns to existing files table (idempotent)
  const filesCols = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
  if (!filesCols.some(c => c.name === "scope_type")) {
    db.exec("ALTER TABLE files ADD COLUMN scope_type TEXT");
  }
  if (!filesCols.some(c => c.name === "scope_id")) {
    db.exec("ALTER TABLE files ADD COLUMN scope_id TEXT");
  }

  // Anthropic sync: maps local resource IDs to remote Anthropic IDs
  db.exec(`
    CREATE TABLE IF NOT EXISTS anthropic_sync (
      local_id TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK(resource_type IN ('agent','environment','vault','session')),
      remote_id TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      config_hash TEXT,
      PRIMARY KEY (local_id, resource_type)
    )
  `);

  // ---------------------------------------------------------------------------
  // v0.4.0 — Agent ops (virtual keys, cost attribution)
  // ---------------------------------------------------------------------------

  // Reserved for v0.5 full tenant isolation. No handler reads this column
  // in v0.4 — it's a forward-compatibility hook so v0.5's migration doesn't
  // need to rewrite this table. Seed key's tenant_id remains NULL = "legacy
  // / global admin" until the operator runs `gateway tenants migrate-legacy`
  // in v0.5.
  const apiKeyCols = db
    .prepare(`PRAGMA table_info(api_keys)`)
    .all() as Array<{ name: string }>;
  if (!apiKeyCols.some((c) => c.name === "tenant_id")) {
    db.exec(`ALTER TABLE api_keys ADD COLUMN tenant_id TEXT`);
  }

  // Per-key cost attribution (v0.4 PR2). Sessions record which API key
  // authenticated the POST /v1/sessions call. Legacy sessions remain NULL
  // — metrics attribute them to the "__unattributed__" bucket.
  const sessionColsApiKey = db
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string }>;
  if (!sessionColsApiKey.some((c) => c.name === "api_key_id")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN api_key_id TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_api_key_id ON sessions(api_key_id)`);

  // Budgets + RPM + fallback (v0.4 PR3).
  // - api_keys.budget_usd / rate_limit_rpm: null = unlimited.
  // - api_keys.spent_usd: running total, default 0. Incremented in the
  //   driver's bumpSessionStats transaction so spend can never
  //   under-report on crash.
  // - agents.fallback_json: JSON array of {agent_id, environment_id}
  //   tuples tried on session-creation failure (cycle-detected, max 3 hops).
  const apiKeyColsBudget = db
    .prepare(`PRAGMA table_info(api_keys)`)
    .all() as Array<{ name: string }>;
  if (!apiKeyColsBudget.some((c) => c.name === "budget_usd")) {
    db.exec(`ALTER TABLE api_keys ADD COLUMN budget_usd REAL`);
  }
  if (!apiKeyColsBudget.some((c) => c.name === "rate_limit_rpm")) {
    db.exec(`ALTER TABLE api_keys ADD COLUMN rate_limit_rpm INTEGER`);
  }
  if (!apiKeyColsBudget.some((c) => c.name === "spent_usd")) {
    db.exec(`ALTER TABLE api_keys ADD COLUMN spent_usd REAL NOT NULL DEFAULT 0`);
  }

  const agentColsFallback = db
    .prepare(`PRAGMA table_info(agents)`)
    .all() as Array<{ name: string }>;
  if (!agentColsFallback.some((c) => c.name === "fallback_json")) {
    db.exec(`ALTER TABLE agents ADD COLUMN fallback_json TEXT`);
  }

  // Upstream-key pool (v0.4 PR4). Per-provider pool with LRU selection and
  // per-row disable-on-failure. Values encrypted via the same AES-256-GCM
  // machinery that protects vault entries (see db/vault-crypto.ts).
  db.exec(`
    CREATE TABLE IF NOT EXISTS upstream_keys (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      value_encrypted TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      disabled_at INTEGER,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_upstream_keys_provider_active
       ON upstream_keys(provider, disabled_at, last_used_at)`,
  );
}
