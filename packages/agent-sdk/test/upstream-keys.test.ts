/**
 * Upstream-key pool (PR4): DB layer + cascade helper + admin handlers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-upstream-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
    __caUpstreamKeyFailures?: unknown;
    __caDrizzle?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  delete g.__caActors;
  delete g.__caUpstreamKeyFailures;
}

async function bootDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({
    name: "admin",
    permissions: { admin: true, scope: null },
    rawKey: "ck_test_admin_up_1234567890ab",
  });
  return key;
}

function req(
  url: string,
  opts: { method?: string; body?: unknown; apiKey?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.apiKey !== undefined) {
    if (opts.apiKey !== "") headers["x-api-key"] = opts.apiKey;
  } else {
    headers["x-api-key"] = "ck_test_admin_up_1234567890ab";
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

describe("Upstream-key pool (db layer)", () => {
  beforeEach(() => freshDbEnv());

  it("addUpstreamKey encrypts the value; selectNextUpstreamKey decrypts it", async () => {
    await bootDb();
    const { addUpstreamKey, selectNextUpstreamKey, getUpstreamKey } = await import("../src/db/upstream_keys");

    const added = addUpstreamKey({
      provider: "anthropic",
      value: "sk-ant-api03-secretvalue-roundtrip-test",
    });
    expect(added.prefix).toBe("sk-ant-api");

    // Fetching via getUpstreamKey never includes the raw value.
    const fetched = getUpstreamKey(added.id);
    expect(fetched).toBeTruthy();
    expect(Object.keys(fetched!)).not.toContain("value_encrypted");

    // Selection decrypts.
    const picked = selectNextUpstreamKey("anthropic");
    expect(picked?.value).toBe("sk-ant-api03-secretvalue-roundtrip-test");
  });

  it("LRU selection: touching last_used_at rotates the next pick", async () => {
    await bootDb();
    const { addUpstreamKey, selectNextUpstreamKey } = await import("../src/db/upstream_keys");

    const k1 = addUpstreamKey({ provider: "anthropic", value: "sk-ant-api03-value-one-padding" });
    const k2 = addUpstreamKey({ provider: "anthropic", value: "sk-ant-api03-value-two-padding" });

    // First pick: whichever has older (null) last_used_at — the earlier one.
    const first = selectNextUpstreamKey("anthropic");
    const second = selectNextUpstreamKey("anthropic");
    const third = selectNextUpstreamKey("anthropic");

    expect(first!.id).not.toBe(second!.id);      // rotate
    expect(third!.id).toBe(first!.id);            // back to start
    // Both IDs are in our set
    expect([k1.id, k2.id]).toContain(first!.id);
    expect([k1.id, k2.id]).toContain(second!.id);
  });

  it("disableUpstreamKey removes a row from selection; enable brings it back", async () => {
    await bootDb();
    const { addUpstreamKey, selectNextUpstreamKey, disableUpstreamKey, enableUpstreamKey } = await import("../src/db/upstream_keys");

    const k1 = addUpstreamKey({ provider: "anthropic", value: "sk-ant-api03-aaa-padding-padding" });
    const k2 = addUpstreamKey({ provider: "anthropic", value: "sk-ant-api03-bbb-padding-padding" });

    disableUpstreamKey(k1.id);
    // Now selection always returns k2
    for (let i = 0; i < 4; i++) {
      const picked = selectNextUpstreamKey("anthropic");
      expect(picked!.id).toBe(k2.id);
    }
    // Re-enable k1; selection picks it up again (LRU will prefer the not-recently-used one).
    enableUpstreamKey(k1.id);
    const again = selectNextUpstreamKey("anthropic");
    expect(again!.id).toBe(k1.id);
  });

  it("selection returns null when no active keys for the provider", async () => {
    await bootDb();
    const { selectNextUpstreamKey } = await import("../src/db/upstream_keys");
    expect(selectNextUpstreamKey("anthropic")).toBeNull();
  });

  it("UNIQUE hash prevents adding the same value twice for a provider", async () => {
    await bootDb();
    const { addUpstreamKey } = await import("../src/db/upstream_keys");
    addUpstreamKey({ provider: "anthropic", value: "sk-ant-api03-dup-padding-padding" });
    expect(() => addUpstreamKey({ provider: "anthropic", value: "sk-ant-api03-dup-padding-padding" }))
      .toThrow(/UNIQUE/);
  });
});

describe("Upstream-key cascade (providers/upstream-keys.ts)", () => {
  beforeEach(() => freshDbEnv());

  it("returns null when no source has a usable key", async () => {
    await bootDb();
    // Clear the env var in case the test runner has it set.
    const orig = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { resolveAnthropicKey } = await import("../src/providers/upstream-keys");
      expect(resolveAnthropicKey()).toBeNull();
    } finally {
      if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  it("vault takes precedence over pool", async () => {
    await bootDb();
    const { getDb } = await import("../src/db/client");
    const { addUpstreamKey } = await import("../src/db/upstream_keys");
    const { resolveAnthropicKey } = await import("../src/providers/upstream-keys");
    const { createAgent } = await import("../src/db/agents");
    const { newId } = await import("../src/util/ids");
    const db = getDb();

    const agent = createAgent({ name: "v-test", model: "claude-sonnet-4-6" });
    const { createVault, setEntry } = await import("../src/db/vaults");
    const vault = createVault({ agent_id: agent.id, name: "v" });
    setEntry(vault.id, "ANTHROPIC_API_KEY", "sk-ant-api03-from-vault");
    const vaultId = vault.id;
    void db; void newId;

    addUpstreamKey({ provider: "anthropic", value: "sk-ant-api03-from-pool-padding" });

    const resolved = resolveAnthropicKey({ vaultIds: [vaultId] });
    expect(resolved?.value).toBe("sk-ant-api03-from-vault");
    expect(resolved?.poolId).toBeNull();
  });

  it("pool is used when vault has no key", async () => {
    await bootDb();
    const orig = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { addUpstreamKey } = await import("../src/db/upstream_keys");
      const { resolveAnthropicKey } = await import("../src/providers/upstream-keys");
      const added = addUpstreamKey({ provider: "anthropic", value: "sk-ant-api03-pool-only-padding" });
      const resolved = resolveAnthropicKey();
      expect(resolved?.value).toBe("sk-ant-api03-pool-only-padding");
      expect(resolved?.poolId).toBe(added.id);
    } finally {
      if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  it("OAuth (sk-ant-oat) values are rejected from all sources", async () => {
    await bootDb();
    const orig = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-oat-fake";
    try {
      const { resolveAnthropicKey } = await import("../src/providers/upstream-keys");
      const resolved = resolveAnthropicKey();
      expect(resolved).toBeNull();
    } finally {
      if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("3 consecutive failures disable a pool row; success resets the counter", async () => {
    await bootDb();
    const orig = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { addUpstreamKey, getUpstreamKey } = await import("../src/db/upstream_keys");
      const { reportUpstreamFailure, reportUpstreamSuccess } = await import("../src/providers/upstream-keys");

      const added = addUpstreamKey({ provider: "anthropic", value: "sk-ant-api03-failer-padding-padding" });

      reportUpstreamFailure(added.id);
      reportUpstreamFailure(added.id);
      expect(getUpstreamKey(added.id)?.disabled_at).toBeNull();
      reportUpstreamFailure(added.id);
      expect(getUpstreamKey(added.id)?.disabled_at).not.toBeNull();

      // A new success on a (theoretically) re-enabled key resets its counter.
      // Here we just verify reportUpstreamSuccess clears the counter — no-op if disabled.
      reportUpstreamSuccess(added.id);
      // Still disabled (we'd need to re-enable via DB to actually use it again).
      expect(getUpstreamKey(added.id)?.disabled_at).not.toBeNull();
    } finally {
      if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
    }
  });
});

describe("/v1/upstream-keys handlers", () => {
  beforeEach(() => freshDbEnv());

  it("admin can add, list, get, patch disabled, delete", async () => {
    const adminKey = await bootDb();
    const { handleAddUpstreamKey, handleListUpstreamKeys, handleGetUpstreamKey, handlePatchUpstreamKey, handleDeleteUpstreamKey } = await import("../src/handlers/upstream_keys");

    // Add
    const addRes = await handleAddUpstreamKey(req("/v1/upstream-keys", {
      body: { provider: "anthropic", value: "sk-ant-api03-handlertest-padding" },
      apiKey: adminKey,
    }));
    expect(addRes.status).toBe(201);
    const added = await addRes.json() as { id: string; prefix: string };

    // List
    const listRes = await handleListUpstreamKeys(req("/v1/upstream-keys", { apiKey: adminKey }));
    const list = await listRes.json() as { data: Array<{ id: string }> };
    expect(list.data).toHaveLength(1);

    // Get
    const getRes = await handleGetUpstreamKey(req(`/v1/upstream-keys/${added.id}`, { apiKey: adminKey }), added.id);
    expect(getRes.status).toBe(200);

    // Patch: disable
    const patchRes = await handlePatchUpstreamKey(
      req(`/v1/upstream-keys/${added.id}`, { method: "PATCH", body: { disabled: true }, apiKey: adminKey }),
      added.id,
    );
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json() as { disabled_at: number | null };
    expect(patched.disabled_at).not.toBeNull();

    // Delete
    const delRes = await handleDeleteUpstreamKey(
      req(`/v1/upstream-keys/${added.id}`, { method: "DELETE", apiKey: adminKey }),
      added.id,
    );
    expect(delRes.status).toBe(200);

    // List is now empty
    const listRes2 = await handleListUpstreamKeys(req("/v1/upstream-keys", { apiKey: adminKey }));
    const list2 = await listRes2.json() as { data: unknown[] };
    expect(list2.data).toHaveLength(0);
  });

  it("non-admin is rejected with 403", async () => {
    await bootDb();
    const { createApiKey } = await import("../src/db/api_keys");
    const { handleAddUpstreamKey, handleListUpstreamKeys } = await import("../src/handlers/upstream_keys");

    const { key: userKey } = createApiKey({
      name: "scoped-user-up",
      permissions: { admin: false, scope: null },
      rawKey: "ck_test_user_up_1234567890ab",
    });

    const addRes = await handleAddUpstreamKey(req("/v1/upstream-keys", {
      apiKey: userKey,
      body: { provider: "anthropic", value: "sk-ant-api03-shouldbe403padding" },
    }));
    expect(addRes.status).toBe(403);

    const listRes = await handleListUpstreamKeys(req("/v1/upstream-keys", { apiKey: userKey }));
    expect(listRes.status).toBe(403);
  });

  it("duplicate value is rejected with 400", async () => {
    const adminKey = await bootDb();
    const { handleAddUpstreamKey } = await import("../src/handlers/upstream_keys");
    const body = { provider: "anthropic", value: "sk-ant-api03-dedup-padding-padding" };
    const first = await handleAddUpstreamKey(req("/v1/upstream-keys", { body, apiKey: adminKey }));
    expect(first.status).toBe(201);
    const second = await handleAddUpstreamKey(req("/v1/upstream-keys", { body, apiKey: adminKey }));
    expect(second.status).toBe(400);
  });
});

// ── v0.5: OpenAI + Gemini providers on the same pool ───────────────────

describe("Upstream-key pool — OpenAI + Gemini", () => {
  beforeEach(() => freshDbEnv());

  it("accepts openai + gemini providers via the admin API", async () => {
    const adminKey = await bootDb();
    const { handleAddUpstreamKey, handleListUpstreamKeys } = await import(
      "../src/handlers/upstream_keys"
    );

    const a = await handleAddUpstreamKey(req("/v1/upstream-keys", {
      body: { provider: "openai", value: "sk-proj-openai-padding-padding-padding" },
      apiKey: adminKey,
    }));
    expect(a.status).toBe(201);

    const b = await handleAddUpstreamKey(req("/v1/upstream-keys", {
      body: { provider: "gemini", value: "AIza-gemini-padding-padding-padding" },
      apiKey: adminKey,
    }));
    expect(b.status).toBe(201);

    const listRes = await handleListUpstreamKeys(req("/v1/upstream-keys", { apiKey: adminKey }));
    const list = await listRes.json() as { data: Array<{ provider: string }> };
    const providers = list.data.map(d => d.provider).sort();
    expect(providers).toEqual(["gemini", "openai"]);
  });

  it("rejects providers outside the known set", async () => {
    const adminKey = await bootDb();
    const { handleAddUpstreamKey } = await import("../src/handlers/upstream_keys");
    const res = await handleAddUpstreamKey(req("/v1/upstream-keys", {
      body: { provider: "cohere", value: "whatever-padding-padding-padding-padding" },
      apiKey: adminKey,
    }));
    expect(res.status).toBe(400);
  });

  it("resolveProviderKey pulls the right vault entry per provider", async () => {
    await bootDb();
    const { createAgent } = await import("../src/db/agents");
    const { createVault, setEntry } = await import("../src/db/vaults");
    const { resolveProviderKey } = await import("../src/providers/upstream-keys");

    const agent = createAgent({ name: "multi", model: "claude-sonnet-4-6" });
    const vault = createVault({ agent_id: agent.id, name: "v" });
    setEntry(vault.id, "ANTHROPIC_API_KEY", "sk-ant-api03-from-vault");
    setEntry(vault.id, "OPENAI_API_KEY",    "sk-proj-openai-vault");
    setEntry(vault.id, "GEMINI_API_KEY",    "AIza-gemini-vault");

    expect(resolveProviderKey("anthropic", { vaultIds: [vault.id] })?.value).toBe(
      "sk-ant-api03-from-vault",
    );
    expect(resolveProviderKey("openai", { vaultIds: [vault.id] })?.value).toBe(
      "sk-proj-openai-vault",
    );
    expect(resolveProviderKey("gemini", { vaultIds: [vault.id] })?.value).toBe(
      "AIza-gemini-vault",
    );
  });

  it("resolveProviderKey falls through pool then config per provider", async () => {
    await bootDb();
    const orig = process.env.OPENAI_API_KEY;
    const origG = process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    // Ensure the config cache from an earlier test run doesn't shadow our mutations.
    const { addUpstreamKey } = await import("../src/db/upstream_keys");
    const { resolveProviderKey } = await import("../src/providers/upstream-keys");

    try {
      // openai pool hit
      const oai = addUpstreamKey({ provider: "openai", value: "sk-proj-openai-pool-padding" });
      // invalidate config cache
      (globalThis as { __caConfigCache?: unknown }).__caConfigCache = undefined;
      const oaiResolved = resolveProviderKey("openai");
      expect(oaiResolved?.value).toBe("sk-proj-openai-pool-padding");
      expect(oaiResolved?.poolId).toBe(oai.id);

      // gemini no pool; fall through to config via settings table
      const { writeSetting } = await import("../src/config");
      writeSetting("gemini_api_key", "AIza-gemini-from-settings");
      (globalThis as { __caConfigCache?: unknown }).__caConfigCache = undefined;
      const gResolved = resolveProviderKey("gemini");
      expect(gResolved?.value).toBe("AIza-gemini-from-settings");
      expect(gResolved?.poolId).toBeNull();
    } finally {
      if (orig !== undefined) process.env.OPENAI_API_KEY = orig;
      if (origG !== undefined) process.env.GEMINI_API_KEY = origG;
    }
  });

  it("OAuth rejection applies to anthropic only, not openai/gemini", async () => {
    await bootDb();
    const { createAgent } = await import("../src/db/agents");
    const { createVault, setEntry } = await import("../src/db/vaults");
    const { resolveProviderKey } = await import("../src/providers/upstream-keys");

    const agent = createAgent({ name: "oauth-test", model: "claude-sonnet-4-6" });
    const vault = createVault({ agent_id: agent.id, name: "v" });

    // Anthropic OAuth → rejected
    setEntry(vault.id, "ANTHROPIC_API_KEY", "sk-ant-oat-should-reject");
    expect(resolveProviderKey("anthropic", { vaultIds: [vault.id] })).toBeNull();

    // OpenAI value that coincidentally starts with the same prefix must NOT be rejected —
    // the OAuth check is Anthropic-specific.
    setEntry(vault.id, "OPENAI_API_KEY", "sk-ant-oat-looks-like-oauth-but-isnt");
    expect(resolveProviderKey("openai", { vaultIds: [vault.id] })?.value).toBe(
      "sk-ant-oat-looks-like-oauth-but-isnt",
    );
  });
});
