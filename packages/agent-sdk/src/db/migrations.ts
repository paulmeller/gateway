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
 *   - sessions.sandbox_name is NULL until first user.message (lazy reservation)
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
      template_sandbox TEXT,
      checkpoint_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_version INTEGER NOT NULL,
      environment_id TEXT NOT NULL,
      sandbox_name TEXT,
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

  // Docker provider: provider_name on sessions
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

  // ---------------------------------------------------------------------------
  // v0.5.0 — Tenancy
  // ---------------------------------------------------------------------------

  // tenants table. `default` tenant is seeded by init.ts on first boot via
  // INSERT OR IGNORE. Archived tenants stay in the table — cost metrics and
  // audit logs can still reference them by id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    )
  `);

  // tenant_id on every resource that needs tenant isolation. Null =
  // "legacy, global-admin-only" until the operator runs
  // `gateway tenants migrate-legacy` to assign it to a tenant. The
  // migration is opt-in so operators can see the transition.
  //
  // Out of scope for v0.5: memory_stores, files, proxy_resources,
  // settings, skills_catalog, anthropic_sync, events (event access is
  // gated via the parent session's tenant). Documented in docs/tenants.md.
  for (const table of ["agents", "environments", "vaults", "sessions"]) {
    const cols = db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "tenant_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT`);
    }
  }
  // api_keys.tenant_id already exists from v0.4 (reserved column).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_tenant       ON agents(tenant_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_environments_tenant ON environments(tenant_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vaults_tenant       ON vaults(tenant_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_tenant     ON sessions(tenant_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_tenant     ON api_keys(tenant_id)`);

  // Webhook HMAC (v0.5 PR4a). Per-agent-version shared secret used to
  // sign webhook payloads. When null, webhooks are delivered unsigned
  // (matches pre-v0.5 behavior). Null -> unsigned delivery; set → all
  // deliveries include X-AgentStep-Signature: sha256=<hex(hmac)>.
  const agentVerColsHook = db
    .prepare(`PRAGMA table_info(agent_versions)`)
    .all() as Array<{ name: string }>;
  if (!agentVerColsHook.some((c) => c.name === "webhook_secret")) {
    db.exec(`ALTER TABLE agent_versions ADD COLUMN webhook_secret TEXT`);
  }

  // Audit log (v0.5 PR4c). Append-only record of admin-sensitive
  // operations (tenant/key/upstream-key/agent CRUD) so operators can
  // reconstruct "who changed what when" after a security incident.
  // Indexed on tenant_id + created_at so tenant-scoped queries stay fast
  // as the table grows.
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id            TEXT PRIMARY KEY,
      created_at    INTEGER NOT NULL,
      actor_key_id  TEXT,
      actor_name    TEXT,
      tenant_id     TEXT,
      action        TEXT NOT NULL,
      resource_type TEXT,
      resource_id   TEXT,
      outcome       TEXT NOT NULL,
      metadata_json TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_log(tenant_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_actor       ON audit_log(actor_key_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_log(action, created_at)`);

  // Proxy routing tenant column (v0.5 P1-2). Proxied resources with no
  // local mirror row previously bypassed tenant checks entirely because
  // the lookup key was absent from every tenant-aware table. Stamp the
  // tenant at mark-time so pure-proxy sessions/agents/envs can still be
  // access-controlled per-tenant. Pre-v0.5 rows stay null and resolve
  // as global-admin-only.
  const proxyCols = db
    .prepare(`PRAGMA table_info(proxy_resources)`)
    .all() as Array<{ name: string }>;
  if (!proxyCols.some((c) => c.name === "tenant_id")) {
    db.exec(`ALTER TABLE proxy_resources ADD COLUMN tenant_id TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_proxy_tenant ON proxy_resources(tenant_id)`);

  // Memory store agent scoping (v0.5). Links a memory store to the
  // agent that owns it. Pre-v0.5 stores have null agent_id and are
  // accessible to global admins only. New stores require an agent_id.
  const memStoreCols = db
    .prepare(`PRAGMA table_info(memory_stores)`)
    .all() as Array<{ name: string }>;
  if (!memStoreCols.some((c) => c.name === "agent_id")) {
    db.exec(`ALTER TABLE memory_stores ADD COLUMN agent_id TEXT`);
  }
  if (!memStoreCols.some(c => c.name === "metadata_json")) {
    db.exec("ALTER TABLE memory_stores ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_stores_agent ON memory_stores(agent_id)`);

  // v0.4 extra columns on memories
  const memoriesCols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!memoriesCols.some(c => c.name === "metadata_json")) {
    db.exec("ALTER TABLE memories ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  }

  // Container file sync: container_path + content_hash on files
  const filesColsSync = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
  if (!filesColsSync.some(c => c.name === "container_path")) {
    db.exec("ALTER TABLE files ADD COLUMN container_path TEXT");
  }
  if (!filesColsSync.some(c => c.name === "content_hash")) {
    db.exec("ALTER TABLE files ADD COLUMN content_hash TEXT");
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_files_dedup ON files(scope_id, container_path, content_hash)`,
  );

  // Session resources table (replaces resources_json on sessions for proper CRUD)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_resources (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      file_id TEXT,
      mount_path TEXT,
      url TEXT,
      checkout_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_resources_session ON session_resources(session_id)`);

  // Widen anthropic_sync CHECK constraint to include 'file' resource type.
  // SQLite doesn't support ALTER CHECK, so recreate the table.
  const syncCheckRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='anthropic_sync'",
  ).get() as { sql: string } | undefined;
  if (syncCheckRow && !syncCheckRow.sql.includes("'file'")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS anthropic_sync_new (
        local_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK(resource_type IN ('agent','environment','vault','session','file')),
        remote_id TEXT NOT NULL,
        synced_at INTEGER NOT NULL,
        config_hash TEXT,
        PRIMARY KEY (local_id, resource_type)
      );
      INSERT OR IGNORE INTO anthropic_sync_new SELECT * FROM anthropic_sync;
      DROP TABLE anthropic_sync;
      ALTER TABLE anthropic_sync_new RENAME TO anthropic_sync;
    `);
  }

  // Vault credentials (Anthropic-compatible structured auth)
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_credentials (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'static_bearer',
      auth_token_encrypted TEXT NOT NULL,
      mcp_server_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE,
      UNIQUE(vault_id, display_name)
    )
  `);

  // Memory versions: version tracking for memory mutations
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_versions (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT,
      content_sha256 TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memver_store ON memory_versions(store_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memver_memory ON memory_versions(memory_id, created_at)`);

  // Memory store archive support
  const memStoreColsArchive = db
    .prepare(`PRAGMA table_info(memory_stores)`)
    .all() as Array<{ name: string }>;
  if (!memStoreColsArchive.some((c) => c.name === "archived_at")) {
    db.exec(`ALTER TABLE memory_stores ADD COLUMN archived_at INTEGER`);
  }

  // v0.5: mcp_oauth support — add expires_at and refresh_config_encrypted columns
  const credCols = db
    .prepare(`PRAGMA table_info(vault_credentials)`)
    .all() as Array<{ name: string }>;
  if (!credCols.some((c) => c.name === "expires_at")) {
    db.exec(`ALTER TABLE vault_credentials ADD COLUMN expires_at TEXT`);
  }
  if (!credCols.some((c) => c.name === "refresh_config_encrypted")) {
    db.exec(`ALTER TABLE vault_credentials ADD COLUMN refresh_config_encrypted TEXT`);
  }

  // Rename sprite_name → sandbox_name, template_sprite → template_sandbox
  const sessCols3 = db
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string }>;
  if (sessCols3.some((c) => c.name === "sprite_name")) {
    db.exec(`ALTER TABLE sessions RENAME COLUMN sprite_name TO sandbox_name`);
  }
  const envCols3 = db
    .prepare(`PRAGMA table_info(environments)`)
    .all() as Array<{ name: string }>;
  if (envCols3.some((c) => c.name === "template_sprite")) {
    db.exec(`ALTER TABLE environments RENAME COLUMN template_sprite TO template_sandbox`);
  }

  // Agent description and metadata
  {
    const cols = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("description")) {
      db.exec("ALTER TABLE agents ADD COLUMN description TEXT");
    }
    if (!names.has("metadata_json")) {
      db.exec("ALTER TABLE agents ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    }
  }

  // Per-session quotas: max_tokens + max_wall_duration_ms
  const sessColsQuota = db
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string }>;
  if (!sessColsQuota.some((c) => c.name === "max_tokens")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN max_tokens INTEGER DEFAULT NULL`);
  }
  if (!sessColsQuota.some((c) => c.name === "max_wall_duration_ms")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN max_wall_duration_ms INTEGER DEFAULT NULL`);
  }

  // Environment updated_at (Anthropic spec alignment).
  {
    const cols = db.prepare("PRAGMA table_info(environments)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "updated_at")) {
      db.exec("ALTER TABLE environments ADD COLUMN updated_at INTEGER");
      // Back-fill: set updated_at = created_at for existing rows.
      db.exec("UPDATE environments SET updated_at = created_at WHERE updated_at IS NULL");
    }
  }

  // Multi-agent session threads table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_threads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_version INTEGER NOT NULL,
      parent_thread_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      stop_reason TEXT,
      usage_input_tokens INTEGER NOT NULL DEFAULT 0,
      usage_output_tokens INTEGER NOT NULL DEFAULT 0,
      usage_cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      usage_cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_threads_session ON session_threads(session_id)`);

  // thread_id on events for thread-scoped event filtering
  const eventColsThread = db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
  if (!eventColsThread.some((c) => c.name === "thread_id")) {
    db.exec(`ALTER TABLE events ADD COLUMN thread_id TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id) WHERE thread_id IS NOT NULL`);

  // multiagent_json on agent_versions
  const avColsMultiagent = db
    .prepare(`PRAGMA table_info(agent_versions)`)
    .all() as Array<{ name: string }>;
  if (!avColsMultiagent.some((c) => c.name === "multiagent_json")) {
    db.exec(`ALTER TABLE agent_versions ADD COLUMN multiagent_json TEXT`);
  }

  // Vault credentials: archived_at column for credential archival
  {
    const cols = db.prepare("PRAGMA table_info(vault_credentials)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("archived_at")) {
      db.exec("ALTER TABLE vault_credentials ADD COLUMN archived_at INTEGER");
    }
  }

  // Skills (standalone, DB-stored with versioning)
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      current_version TEXT,
      tenant_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_versions (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      version TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(skill_id, version),
      FOREIGN KEY (skill_id) REFERENCES skills(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id, created_at)`);

  // Skills table: ensure all columns exist (handles pre-existing tables from older versions)
  {
    const cols = db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("current_version")) db.exec("ALTER TABLE skills ADD COLUMN current_version TEXT");
    if (!names.has("tenant_id")) db.exec("ALTER TABLE skills ADD COLUMN tenant_id TEXT");
    if (!names.has("archived_at")) db.exec("ALTER TABLE skills ADD COLUMN archived_at INTEGER");
    if (!names.has("description")) db.exec("ALTER TABLE skills ADD COLUMN description TEXT");
    if (!names.has("updated_at")) db.exec("ALTER TABLE skills ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
  }

  // Multi-file skills: files_json stores all files in the skill directory
  const skillVersionCols = db
    .prepare(`PRAGMA table_info(skill_versions)`)
    .all() as Array<{ name: string }>;
  if (!skillVersionCols.some((c) => c.name === "files_json")) {
    db.exec(
      `ALTER TABLE skill_versions ADD COLUMN files_json TEXT NOT NULL DEFAULT '{}'`,
    );
  }

  // Memory versions: redacted_at column for version redaction
  {
    const cols = db.prepare("PRAGMA table_info(memory_versions)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("redacted_at")) {
      db.exec("ALTER TABLE memory_versions ADD COLUMN redacted_at INTEGER");
    }
  }

  // Work queue items table
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      worker_id TEXT,
      inputs_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      tenant_id TEXT,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      started_at INTEGER,
      latest_heartbeat_at INTEGER,
      stop_requested_at INTEGER,
      stopped_at INTEGER,
      lease_expires_at INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_env_state ON work_items(environment_id, state)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_work_session ON work_items(session_id)`);

  // Vault metadata + archive + optional agent_id.
  // agent_id was originally NOT NULL — SQLite requires table recreation to
  // drop the constraint. We detect by checking the column's `notnull` flag.
  {
    const cols = db.prepare("PRAGMA table_info(vaults)").all() as Array<{ name: string; notnull: number }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("metadata_json")) {
      db.exec("ALTER TABLE vaults ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!names.has("archived_at")) {
      db.exec("ALTER TABLE vaults ADD COLUMN archived_at INTEGER");
    }
    // Make agent_id nullable (recreate table if still NOT NULL)
    const agentIdCol = cols.find((c) => c.name === "agent_id");
    if (agentIdCol && agentIdCol.notnull === 1) {
      db.exec(`
        CREATE TABLE vaults_new (
          id TEXT PRIMARY KEY,
          agent_id TEXT,
          name TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          tenant_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        );
        INSERT INTO vaults_new SELECT id, agent_id, name,
          COALESCE(metadata_json, '{}'), tenant_id, created_at, updated_at,
          archived_at FROM vaults;
        DROP TABLE vaults;
        ALTER TABLE vaults_new RENAME TO vaults;
      `);
      // Recreate index that was dropped with the old table
      db.exec(`CREATE INDEX IF NOT EXISTS idx_vaults_tenant ON vaults(tenant_id)`);
    }
  }

  // User profiles: per-user credential scoping via trust grants
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      external_id TEXT,
      display_name TEXT,
      trust_grants_json TEXT NOT NULL DEFAULT '[]',
      tenant_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, external_id)
    )
  `);

  // Add user_profile_id to sessions (safe ALTER — column may already exist)
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN user_profile_id TEXT`);
  } catch { /* column already exists */ }

  // Permission policy on agent_versions (per-agent tool permission overrides)
  try {
    db.exec(`ALTER TABLE agent_versions ADD COLUMN permission_policy_json TEXT`);
  } catch { /* column already exists */ }

  // 0.5.45: debug-prompt capture column on sessions. Null = disabled.
  // When debug capture is requested at session create time (header
  // `X-AgentStep-Debug: prompt` or query `?debug=prompt`), this column
  // is initialized to the sentinel `{"pending":true}`. The session
  // driver replaces it with the captured payload on the first turn.
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN debug_prompt_json TEXT`);
  } catch { /* column already exists */ }

  // 0.5.64: ZDR Phase 0a — backfill NULL tenant_id rows from pre-0.5.
  //
  // The tenant_id columns on `sessions` and `audit_log` were added as
  // nullable ALTER TABLE during the v0.5 multi-tenancy work. Rows
  // created before that migration have NULL tenant_id and can't be
  // tenant-filtered, which would let a ZDR purge or a tenant-scoped
  // query miss them. We backfill "tenant_default" (the canonical
  // single-tenant id every pre-0.5 install was on) for any NULL row.
  //
  // Idempotent: re-running affects zero rows once filled.
  //
  // NOTE: `events` and `memory_stores` deliberately do NOT have
  // tenant_id columns today. ZDR purge doesn't need them — it
  // resolves the tenant from `sessions.tenant_id` before any DELETE,
  // and the session_id FK on events/memory_versions/etc. is unique
  // and bound to that session. Adding tenant_id columns there is
  // defense-in-depth worth doing in a follow-up, but it's NOT a ZDR
  // prerequisite. Both prior architect reviews of the ZDR plan were
  // wrong about events/memory_stores already having the column —
  // this comment exists so the next person looking doesn't make the
  // same mistake.
  db.exec(`UPDATE sessions  SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL`);
  db.exec(`UPDATE audit_log SET tenant_id = 'tenant_default' WHERE tenant_id IS NULL`);
}
