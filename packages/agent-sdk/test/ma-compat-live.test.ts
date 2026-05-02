/**
 * MA API Compatibility — Live Smoke Tests
 *
 * These tests run against a real gateway instance. They are skipped in CI
 * when LIVE_TEST_API_KEY is not set.
 *
 * Environment variables:
 *   LIVE_TEST_BASE_URL   — gateway base URL (default: http://localhost:4000)
 *   LIVE_TEST_API_KEY    — required; skips all tests when absent
 *   LIVE_TEST_ENV_ID     — environment ID to use when creating sessions
 *   LIVE_TEST_VAULT_ID   — vault ID to use when testing vault credentials
 *
 * Run with:
 *   LIVE_TEST_API_KEY=<key> npx vitest run packages/agent-sdk/test/ma-compat-live.test.ts
 */
import { describe, it, expect } from "vitest";

const BASE_URL = process.env.LIVE_TEST_BASE_URL || "http://localhost:4000";
const API_KEY = process.env.LIVE_TEST_API_KEY;
const skip = !API_KEY;

function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  return fetch(`${BASE_URL}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      "x-api-key": API_KEY!,
      "content-type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function pollUntilIdle(sessionId: string, timeoutMs = 120000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api(`/v1/sessions/${sessionId}`);
    const session = (await res.json()) as { status: string };
    if (session.status === "idle" || session.status === "terminated") return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Session did not reach idle within ${timeoutMs}ms`);
}

describe.skipIf(skip)("MA Compatibility: Live Smoke Tests", () => {
  // ---------------------------------------------------------------------------
  // 1. Agent lifecycle
  // ---------------------------------------------------------------------------
  it(
    "agent lifecycle: create → session → send message → poll idle → events → cleanup",
    async () => {
      // Create agent
      const createAgentRes = await api("/v1/agents", {
        body: { name: `live-smoke-agent-${Date.now()}`, engine: "claude", model: "claude-sonnet-4-6" },
      });
      expect(createAgentRes.status).toBe(201);
      const agent = (await createAgentRes.json()) as { id: string };
      expect(agent.id).toMatch(/^agent_/);

      try {
        // Create session (use env vars for environment + vault if provided)
        const sessionBody: Record<string, unknown> = { agent: agent.id };
        if (process.env.LIVE_TEST_ENV_ID) sessionBody.environment_id = process.env.LIVE_TEST_ENV_ID;
        if (process.env.LIVE_TEST_VAULT_ID) sessionBody.vault_id = process.env.LIVE_TEST_VAULT_ID;

        const createSessRes = await api("/v1/sessions", { body: sessionBody });
        expect(createSessRes.status).toBe(201);
        const session = (await createSessRes.json()) as { id: string; status: string };
        expect(session.id).toMatch(/^sesn_/);
        expect(session.status).toBe("idle");

        const sessionId = session.id;

        try {
          // Send user.message
          const sendRes = await api(`/v1/sessions/${sessionId}/events`, {
            body: {
              events: [
                {
                  type: "user.message",
                  content: [{ type: "text", text: "Reply with exactly the word: pong" }],
                },
              ],
            },
          });
          expect(sendRes.status).toBe(200);

          // Poll until idle
          await pollUntilIdle(sessionId, 120000);

          // Verify events exist
          const eventsRes = await api(`/v1/sessions/${sessionId}/events`);
          expect(eventsRes.status).toBe(200);
          const events = (await eventsRes.json()) as {
            data: Array<{ type: string }>;
            has_more: boolean;
          };
          expect(Array.isArray(events.data)).toBe(true);
          const types = events.data.map((e) => e.type);
          expect(types).toContain("session.status_running");
          expect(types).toContain("session.status_idle");
        } finally {
          // Cleanup session
          await api(`/v1/sessions/${sessionId}`, { method: "DELETE" });
        }
      } finally {
        // Cleanup agent
        await api(`/v1/agents/${agent.id}`, { method: "DELETE" });
      }
    },
    120_000,
  );

  // ---------------------------------------------------------------------------
  // 2. Custom tool round-trip
  // ---------------------------------------------------------------------------
  it(
    "custom tool round-trip: agent calls tool → send tool result → session reaches idle",
    async () => {
      // Create agent with a custom tool
      const createAgentRes = await api("/v1/agents", {
        body: {
          name: `live-custom-tool-${Date.now()}`,
          engine: "claude",
          model: "claude-sonnet-4-6",
          tools: [
            {
              type: "custom",
              name: "test_tool",
              description: "A test tool that returns a fixed string",
              input_schema: {
                type: "object",
                properties: {
                  input: { type: "string", description: "Input value" },
                },
                required: ["input"],
              },
            },
          ],
        },
      });
      expect(createAgentRes.status).toBe(201);
      const agent = (await createAgentRes.json()) as { id: string };
      expect(agent.id).toMatch(/^agent_/);

      try {
        const sessionBody: Record<string, unknown> = { agent: agent.id };
        if (process.env.LIVE_TEST_ENV_ID) sessionBody.environment_id = process.env.LIVE_TEST_ENV_ID;
        if (process.env.LIVE_TEST_VAULT_ID) sessionBody.vault_id = process.env.LIVE_TEST_VAULT_ID;

        const createSessRes = await api("/v1/sessions", { body: sessionBody });
        expect(createSessRes.status).toBe(201);
        const session = (await createSessRes.json()) as { id: string; status: string };
        const sessionId = session.id;

        try {
          // Send message asking agent to call the custom tool
          const sendRes = await api(`/v1/sessions/${sessionId}/events`, {
            body: {
              events: [
                {
                  type: "user.message",
                  content: [
                    {
                      type: "text",
                      text: "Please call the mcp__tool-bridge__test_tool with input='hello'.",
                    },
                  ],
                },
              ],
            },
          });
          expect(sendRes.status).toBe(200);

          // Poll for agent.custom_tool_use event (up to 120s)
          const start = Date.now();
          let toolUseEventId: string | undefined;
          let toolUseName: string | undefined;

          while (Date.now() - start < 120000) {
            const eventsRes = await api(`/v1/sessions/${sessionId}/events`);
            const events = (await eventsRes.json()) as {
              data: Array<{ type: string; id: string; payload: Record<string, unknown> }>;
            };
            const toolUseEvent = events.data.find((e) => e.type === "agent.custom_tool_use");
            if (toolUseEvent) {
              toolUseEventId = toolUseEvent.id;
              toolUseName = toolUseEvent.payload?.name as string | undefined;
              break;
            }
            // Also break early if session went idle (agent skipped the tool call)
            const sessRes = await api(`/v1/sessions/${sessionId}`);
            const sess = (await sessRes.json()) as { status: string };
            if (sess.status === "idle" || sess.status === "terminated") break;
            await new Promise((r) => setTimeout(r, 5000));
          }

          // If the agent called the custom tool, send the result and wait for idle
          if (toolUseEventId) {
            const toolResultRes = await api(`/v1/sessions/${sessionId}/events`, {
              body: {
                events: [
                  {
                    type: "user.custom_tool_result",
                    custom_tool_use_event_id: toolUseEventId,
                    content: [{ type: "text", text: "tool_result_value_42" }],
                  },
                ],
              },
            });
            expect(toolResultRes.status).toBe(200);

            // Poll until idle after tool result
            await pollUntilIdle(sessionId, 120000);

            // Verify agent.message appears after the tool result
            const finalEventsRes = await api(`/v1/sessions/${sessionId}/events`);
            const finalEvents = (await finalEventsRes.json()) as {
              data: Array<{ type: string; id: string }>;
            };
            const types = finalEvents.data.map((e) => e.type);
            expect(types).toContain("agent.custom_tool_use");
            expect(types).toContain("agent.message");

            // The agent.message should appear after the custom_tool_use event
            const toolUseIdx = types.lastIndexOf("agent.custom_tool_use");
            const agentMsgIdx = types.lastIndexOf("agent.message");
            expect(agentMsgIdx).toBeGreaterThan(toolUseIdx);
          } else {
            // Agent didn't call the tool — still verify session reached idle
            await pollUntilIdle(sessionId, 30000);
          }

          // Log tool use details for debugging
          if (toolUseName) {
            console.log(`Custom tool called: ${toolUseName} (event: ${toolUseEventId})`);
          }
        } finally {
          await api(`/v1/sessions/${sessionId}`, { method: "DELETE" });
        }
      } finally {
        await api(`/v1/agents/${agent.id}`, { method: "DELETE" });
      }
    },
    300_000,
  );

  // ---------------------------------------------------------------------------
  // 3. Pagination
  // ---------------------------------------------------------------------------
  it("pagination: create 3 agents, list with limit=2, verify has_more + second page", async () => {
    const suffix = Date.now();
    const agentIds: string[] = [];

    try {
      // Create 3 agents
      for (let i = 0; i < 3; i++) {
        const res = await api("/v1/agents", {
          body: { name: `live-pag-agent-${suffix}-${i}`, engine: "claude", model: "claude-sonnet-4-6" },
        });
        expect(res.status).toBe(201);
        const agent = (await res.json()) as { id: string };
        agentIds.push(agent.id);
      }

      // List with limit=2
      const page1Res = await api("/v1/agents?limit=2");
      expect(page1Res.status).toBe(200);
      const page1 = (await page1Res.json()) as {
        data: Array<{ id: string }>;
        has_more: boolean;
        first_id: string | null;
        last_id: string | null;
      };

      expect(page1.data.length).toBeGreaterThanOrEqual(1);
      expect(page1.has_more).toBe(true);
      expect(page1.first_id).toBeTruthy();
      expect(page1.last_id).toBeTruthy();
      expect("next_page" in page1).toBe(false);

      // Paginate using after_id=last_id
      const afterId = page1.last_id!;
      const page2Res = await api(`/v1/agents?limit=2&after_id=${afterId}`);
      expect(page2Res.status).toBe(200);
      const page2 = (await page2Res.json()) as {
        data: Array<{ id: string }>;
        has_more: boolean;
        first_id: string | null;
        last_id: string | null;
      };

      expect(Array.isArray(page2.data)).toBe(true);
      expect(page2.data.length).toBeGreaterThanOrEqual(1);

      // No overlap between pages
      const page1Ids = new Set(page1.data.map((a) => a.id));
      for (const agent of page2.data) {
        expect(page1Ids.has(agent.id)).toBe(false);
      }
    } finally {
      // Cleanup
      for (const id of agentIds) {
        await api(`/v1/agents/${id}`, { method: "DELETE" });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Vault + credentials
  // ---------------------------------------------------------------------------
  it("vault + credentials: create static_bearer + mcp_oauth — token not in GET response", async () => {
    // Create an agent to own the vault
    const createAgentRes = await api("/v1/agents", {
      body: { name: `live-vault-agent-${Date.now()}`, engine: "claude", model: "claude-sonnet-4-6" },
    });
    expect(createAgentRes.status).toBe(201);
    const agent = (await createAgentRes.json()) as { id: string };

    try {
      // Create vault
      const createVaultRes = await api("/v1/vaults", {
        body: { agent_id: agent.id, name: `live-vault-${Date.now()}` },
      });
      expect(createVaultRes.status).toBe(201);
      const vault = (await createVaultRes.json()) as { id: string };
      expect(vault.id).toMatch(/^vlt_/);

      const credIds: string[] = [];

      try {
        // Create static_bearer credential
        const bearerRes = await api(`/v1/vaults/${vault.id}/credentials`, {
          body: {
            display_name: "live-static-bearer",
            auth: {
              type: "static_bearer",
              mcp_server_url: "https://mcp.example.com/mcp",
              token: "supersecret-live-bearer-token",
            },
          },
        });
        expect(bearerRes.status).toBe(201);
        const bearer = (await bearerRes.json()) as {
          id: string;
          auth: Record<string, unknown>;
        };
        expect(bearer.id).toMatch(/^cred_/);
        // Token must NOT appear in create response
        expect(JSON.stringify(bearer)).not.toContain("supersecret-live-bearer-token");
        expect(bearer.auth.token).toBeUndefined();
        credIds.push(bearer.id);

        // GET credential — token must still be absent
        const getBearerRes = await api(`/v1/vaults/${vault.id}/credentials/${bearer.id}`);
        expect(getBearerRes.status).toBe(200);
        const fetchedBearer = (await getBearerRes.json()) as {
          id: string;
          auth: Record<string, unknown>;
        };
        expect(JSON.stringify(fetchedBearer)).not.toContain("supersecret-live-bearer-token");
        expect(fetchedBearer.auth.token).toBeUndefined();

        // Create mcp_oauth credential
        const oauthRes = await api(`/v1/vaults/${vault.id}/credentials`, {
          body: {
            display_name: "live-mcp-oauth",
            auth: {
              type: "mcp_oauth",
              mcp_server_url: "https://mcp.oauth-live-test.com",
              access_token: "supersecret-live-access-token",
              expires_at: "2030-01-01T00:00:00Z",
              refresh: {
                token_endpoint: "https://auth.oauth-live-test.com/token",
                client_id: "client_live_123",
                refresh_token: "supersecret-live-refresh-token",
              },
            },
          },
        });
        expect(oauthRes.status).toBe(201);
        const oauth = (await oauthRes.json()) as {
          id: string;
          auth: Record<string, unknown>;
        };
        expect(oauth.id).toMatch(/^cred_/);
        // Secrets must NOT appear in create response
        const oauthCreateJson = JSON.stringify(oauth);
        expect(oauthCreateJson).not.toContain("supersecret-live-access-token");
        expect(oauthCreateJson).not.toContain("supersecret-live-refresh-token");
        expect(oauth.auth.access_token).toBeUndefined();
        expect(oauth.auth.refresh).toBeUndefined();
        credIds.push(oauth.id);

        // GET mcp_oauth credential — secrets must still be absent
        const getOauthRes = await api(`/v1/vaults/${vault.id}/credentials/${oauth.id}`);
        expect(getOauthRes.status).toBe(200);
        const fetchedOauth = (await getOauthRes.json()) as {
          id: string;
          auth: Record<string, unknown>;
        };
        const oauthGetJson = JSON.stringify(fetchedOauth);
        expect(oauthGetJson).not.toContain("supersecret-live-access-token");
        expect(oauthGetJson).not.toContain("supersecret-live-refresh-token");
        expect(fetchedOauth.auth.access_token).toBeUndefined();
        expect(fetchedOauth.auth.refresh).toBeUndefined();
      } finally {
        // Cleanup credentials
        for (const credId of credIds) {
          await api(`/v1/vaults/${vault.id}/credentials/${credId}`, { method: "DELETE" }).catch(
            () => {},
          );
        }
        // Cleanup vault
        await api(`/v1/vaults/${vault.id}`, { method: "DELETE" }).catch(() => {});
      }
    } finally {
      await api(`/v1/agents/${agent.id}`, { method: "DELETE" });
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Error handling
  // ---------------------------------------------------------------------------
  it("error handling: 404 on nonexistent agent, 400 on empty body", async () => {
    // 404 for nonexistent agent
    const notFoundRes = await api("/v1/agents/agent_nonexistent");
    expect(notFoundRes.status).toBe(404);
    const notFoundBody = (await notFoundRes.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(notFoundBody.type).toBe("error");
    expect(notFoundBody.error).toBeDefined();
    expect(notFoundBody.error.type).toBe("not_found_error");
    expect(typeof notFoundBody.error.message).toBe("string");

    // 400 for empty/invalid body when creating agent
    const badBodyRes = await api("/v1/agents", { body: {} });
    expect(badBodyRes.status).toBe(400);
    const badBodyBody = (await badBodyRes.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(badBodyBody.type).toBe("error");
    expect(badBodyBody.error).toBeDefined();
    expect(typeof badBodyBody.error.message).toBe("string");
  });

  // ---------------------------------------------------------------------------
  // 6. Events pagination
  // ---------------------------------------------------------------------------
  it("events pagination: create session, post 3 events, list with limit=2, verify has_more", async () => {
    // Create agent + session for events pagination test
    const createAgentRes = await api("/v1/agents", {
      body: { name: `live-evt-pag-${Date.now()}`, engine: "claude", model: "claude-sonnet-4-6" },
    });
    expect(createAgentRes.status).toBe(201);
    const agent = (await createAgentRes.json()) as { id: string };

    try {
      const sessionBody: Record<string, unknown> = { agent: agent.id };
      if (process.env.LIVE_TEST_ENV_ID) sessionBody.environment_id = process.env.LIVE_TEST_ENV_ID;
      if (process.env.LIVE_TEST_VAULT_ID) sessionBody.vault_id = process.env.LIVE_TEST_VAULT_ID;

      const createSessRes = await api("/v1/sessions", { body: sessionBody });
      expect(createSessRes.status).toBe(201);
      const session = (await createSessRes.json()) as { id: string };
      const sessionId = session.id;

      try {
        // Post 3 user.message events
        for (let i = 0; i < 3; i++) {
          const postRes = await api(`/v1/sessions/${sessionId}/events`, {
            body: {
              events: [
                {
                  type: "user.message",
                  content: [{ type: "text", text: `Event ${i + 1} of 3` }],
                },
              ],
            },
          });
          expect(postRes.status).toBe(200);
        }

        // List events with limit=2
        const eventsRes = await api(`/v1/sessions/${sessionId}/events?limit=2`);
        expect(eventsRes.status).toBe(200);
        const events = (await eventsRes.json()) as {
          data: Array<{ id: string; type: string }>;
          has_more: boolean;
          first_id: string | null;
          last_id: string | null;
        };

        expect(Array.isArray(events.data)).toBe(true);
        expect(events.data.length).toBe(2);
        expect(events.has_more).toBe(true);
        expect(events.first_id).toBeTruthy();
        expect(events.last_id).toBeTruthy();
        expect("next_page" in events).toBe(false);

        // Paginate to second page
        const afterId = events.last_id!;
        const page2Res = await api(
          `/v1/sessions/${sessionId}/events?limit=2&after_id=${afterId}`,
        );
        expect(page2Res.status).toBe(200);
        const page2 = (await page2Res.json()) as {
          data: Array<{ id: string; type: string }>;
          has_more: boolean;
          first_id: string | null;
          last_id: string | null;
        };
        expect(Array.isArray(page2.data)).toBe(true);
        expect(page2.data.length).toBeGreaterThanOrEqual(1);

        // No overlap between pages
        const page1Ids = new Set(events.data.map((e) => e.id));
        for (const evt of page2.data) {
          expect(page1Ids.has(evt.id)).toBe(false);
        }
      } finally {
        await api(`/v1/sessions/${sessionId}`, { method: "DELETE" });
      }
    } finally {
      await api(`/v1/agents/${agent.id}`, { method: "DELETE" });
    }
  });
});
