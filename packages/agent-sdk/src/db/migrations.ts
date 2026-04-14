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
}
