import { describe, it, expect } from "vitest";
import { injectMcpAuthHeaders } from "../src/sessions/mcp-auth";
import type { Agent } from "../src/types";

function makeAgent(mcpServers: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>): Agent {
  return {
    id: "agent_test",
    version: 1,
    name: "test",
    model: "claude-sonnet-4-6",
    engine: "claude",
    system: null,
    tools: [],
    mcp_servers: mcpServers as Agent["mcp_servers"],
    webhook_url: null,
    webhook_events: [],
    webhook_signing_enabled: false,
    threads_enabled: false,
    confirmation_mode: false,
    callable_agents: [],
    skills: [],
    model_config: {},
    fallback_json: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as Agent;
}

describe("injectMcpAuthHeaders", () => {
  it("injects MCP_AUTH_{SERVER} as Authorization: Bearer header", () => {
    const agent = makeAgent({
      github: { type: "sse", url: "https://mcp.github.com" },
    });
    const result = injectMcpAuthHeaders(agent, [
      { key: "MCP_AUTH_GITHUB", value: "ghp_abc123" },
    ]);
    expect(result.mcp_servers.github.headers).toEqual({
      Authorization: "Bearer ghp_abc123",
    });
  });

  it("matches server names case-insensitively", () => {
    const agent = makeAgent({
      "My-Server": { type: "http", url: "https://example.com" },
    });
    const result = injectMcpAuthHeaders(agent, [
      { key: "MCP_AUTH_MY_SERVER", value: "token123" },
    ]);
    expect(result.mcp_servers["My-Server"].headers).toEqual({
      Authorization: "Bearer token123",
    });
  });

  it("converts hyphens to underscores for matching", () => {
    const agent = makeAgent({
      "slack-bot": { type: "http", url: "https://slack.mcp.dev" },
    });
    const result = injectMcpAuthHeaders(agent, [
      { key: "MCP_AUTH_SLACK_BOT", value: "xoxb-token" },
    ]);
    expect(result.mcp_servers["slack-bot"].headers).toEqual({
      Authorization: "Bearer xoxb-token",
    });
  });

  it("injects MCP_HEADER_{SERVER}_{HEADER} as custom header", () => {
    const agent = makeAgent({
      notion: { type: "http", url: "https://mcp.notion.so" },
    });
    const result = injectMcpAuthHeaders(agent, [
      { key: "MCP_HEADER_NOTION_X-API-KEY", value: "ntn_abc" },
    ]);
    // X-API-KEY splits as NOTION + X-API-KEY
    expect(result.mcp_servers.notion.headers?.["X-API-KEY"]).toBe("ntn_abc");
  });

  it("merges with existing headers without overwriting", () => {
    const agent = makeAgent({
      github: {
        type: "sse",
        url: "https://mcp.github.com",
        headers: { "X-Custom": "existing" },
      },
    });
    const result = injectMcpAuthHeaders(agent, [
      { key: "MCP_AUTH_GITHUB", value: "ghp_abc123" },
    ]);
    expect(result.mcp_servers.github.headers).toEqual({
      "X-Custom": "existing",
      Authorization: "Bearer ghp_abc123",
    });
  });

  it("does not mutate the original agent", () => {
    const agent = makeAgent({
      github: { type: "sse", url: "https://mcp.github.com" },
    });
    injectMcpAuthHeaders(agent, [
      { key: "MCP_AUTH_GITHUB", value: "ghp_abc123" },
    ]);
    expect(agent.mcp_servers.github.headers).toBeUndefined();
  });

  it("returns same agent if no MCP servers", () => {
    const agent = makeAgent({});
    const result = injectMcpAuthHeaders(agent, [
      { key: "MCP_AUTH_GITHUB", value: "token" },
    ]);
    expect(result).toBe(agent);
  });

  it("returns same agent if no vault entries", () => {
    const agent = makeAgent({
      github: { type: "sse", url: "https://mcp.github.com" },
    });
    const result = injectMcpAuthHeaders(agent, []);
    expect(result).toBe(agent);
  });

  it("returns same agent if no matching vault keys", () => {
    const agent = makeAgent({
      github: { type: "sse", url: "https://mcp.github.com" },
    });
    const result = injectMcpAuthHeaders(agent, [
      { key: "ANTHROPIC_API_KEY", value: "sk-ant-123" },
      { key: "SOME_OTHER_KEY", value: "value" },
    ]);
    expect(result).toBe(agent);
  });

  it("handles multiple servers and multiple vault entries", () => {
    const agent = makeAgent({
      github: { type: "sse", url: "https://mcp.github.com" },
      slack: { type: "http", url: "https://mcp.slack.com" },
      notion: { type: "http", url: "https://mcp.notion.so" },
    });
    const result = injectMcpAuthHeaders(agent, [
      { key: "MCP_AUTH_GITHUB", value: "ghp_abc" },
      { key: "MCP_AUTH_SLACK", value: "xoxb-123" },
      { key: "ANTHROPIC_API_KEY", value: "sk-ant-123" }, // should be ignored
    ]);
    expect(result.mcp_servers.github.headers).toEqual({ Authorization: "Bearer ghp_abc" });
    expect(result.mcp_servers.slack.headers).toEqual({ Authorization: "Bearer xoxb-123" });
    expect(result.mcp_servers.notion.headers).toBeUndefined();
  });

  it("longest server name wins for ambiguous MCP_HEADER matches", () => {
    const agent = makeAgent({
      my: { type: "http", url: "https://my.example.com" },
      my_api: { type: "http", url: "https://my-api.example.com" },
    });
    const result = injectMcpAuthHeaders(agent, [
      { key: "MCP_HEADER_MY_API_TOKEN", value: "secret" },
    ]);
    // Should match "my_api" (longer) with header "TOKEN", not "my" with header "API-TOKEN"
    expect(result.mcp_servers.my_api.headers).toEqual({ TOKEN: "secret" });
    expect(result.mcp_servers.my.headers).toBeUndefined();
  });

  it("MCP_HEADER with underscored header name joins with hyphens", () => {
    const agent = makeAgent({
      notion: { type: "http", url: "https://mcp.notion.so" },
    });
    const result = injectMcpAuthHeaders(agent, [
      { key: "MCP_HEADER_NOTION_X_API_VERSION", value: "2024-01-01" },
    ]);
    expect(result.mcp_servers.notion.headers).toEqual({ "X-API-VERSION": "2024-01-01" });
  });

  it("MCP_AUTH for unknown server is ignored", () => {
    const agent = makeAgent({
      github: { type: "sse", url: "https://mcp.github.com" },
    });
    const result = injectMcpAuthHeaders(agent, [
      { key: "MCP_AUTH_UNKNOWN", value: "token" },
    ]);
    expect(result).toBe(agent);
  });

  it("MCP_AUTH keys should not appear in env var filtering regex", () => {
    // This tests the convention that MCP_AUTH_* and MCP_HEADER_* are filtered
    // from env injection in driver.ts. The regex is: /^MCP_(AUTH|HEADER)_/i
    const re = /^MCP_(AUTH|HEADER)_/i;
    expect(re.test("MCP_AUTH_GITHUB")).toBe(true);
    expect(re.test("MCP_HEADER_SLACK_TOKEN")).toBe(true);
    expect(re.test("mcp_auth_notion")).toBe(true);
    expect(re.test("ANTHROPIC_API_KEY")).toBe(false);
    expect(re.test("MCP_SERVER_URL")).toBe(false);
  });
});
