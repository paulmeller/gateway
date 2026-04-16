export type SnippetLang = "curl" | "python" | "typescript";

export interface ResourceSnippets {
  list: Record<SnippetLang, string>;
  get?: Record<SnippetLang, string>;
  update?: Record<SnippetLang, string>;
  delete?: Record<SnippetLang, string>;
}

const BASE_URL = "http://localhost:4111";

// ─── agents ──────────────────────────────────────────────────────────────────

const agents: ResourceSnippets = {
  list: {
    curl: `curl -H "x-api-key: $KEY" ${BASE_URL}/v1/agents`,
    python: `from anthropic import Anthropic
client = Anthropic(base_url="${BASE_URL}")
agents = client.beta.agents.list()`,
    typescript: `import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "${BASE_URL}" });
const agents = await client.beta.agents.list();`,
  },
  get: {
    curl: `curl -H "x-api-key: $KEY" ${BASE_URL}/v1/agents/{id}`,
    python: `from anthropic import Anthropic
client = Anthropic(base_url="${BASE_URL}")
agent = client.beta.agents.retrieve("{id}")`,
    typescript: `import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "${BASE_URL}" });
const agent = await client.beta.agents.retrieve("{id}");`,
  },
  update: {
    curl: `curl -X PUT -H "x-api-key: $KEY" -H "Content-Type: application/json" \\
  -d '{"name":"updated-name"}' \\
  ${BASE_URL}/v1/agents/{id}`,
    python: `from anthropic import Anthropic
client = Anthropic(base_url="${BASE_URL}")
agent = client.beta.agents.update("{id}", name="updated-name")`,
    typescript: `import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "${BASE_URL}" });
const agent = await client.beta.agents.update("{id}", { name: "updated-name" });`,
  },
  delete: {
    curl: `curl -X DELETE -H "x-api-key: $KEY" ${BASE_URL}/v1/agents/{id}`,
    python: `from anthropic import Anthropic
client = Anthropic(base_url="${BASE_URL}")
client.beta.agents.delete("{id}")`,
    typescript: `import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "${BASE_URL}" });
await client.beta.agents.delete("{id}");`,
  },
};

// ─── sessions ─────────────────────────────────────────────────────────────────

const sessions: ResourceSnippets = {
  list: {
    curl: `curl -H "x-api-key: $KEY" ${BASE_URL}/v1/sessions`,
    python: `from anthropic import Anthropic
client = Anthropic(base_url="${BASE_URL}")
sessions = client.beta.sessions.list()`,
    typescript: `import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "${BASE_URL}" });
const sessions = await client.beta.sessions.list();`,
  },
  get: {
    curl: `curl -H "x-api-key: $KEY" ${BASE_URL}/v1/sessions/{id}`,
    python: `from anthropic import Anthropic
client = Anthropic(base_url="${BASE_URL}")
session = client.beta.sessions.retrieve("{id}")`,
    typescript: `import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "${BASE_URL}" });
const session = await client.beta.sessions.retrieve("{id}");`,
  },
  delete: {
    curl: `curl -X DELETE -H "x-api-key: $KEY" ${BASE_URL}/v1/sessions/{id}`,
    python: `from anthropic import Anthropic
client = Anthropic(base_url="${BASE_URL}")
client.beta.sessions.delete("{id}")`,
    typescript: `import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "${BASE_URL}" });
await client.beta.sessions.delete("{id}");`,
  },
};

// ─── environments ─────────────────────────────────────────────────────────────

const environments: ResourceSnippets = {
  list: {
    curl: `curl -H "x-api-key: $KEY" ${BASE_URL}/v1/environments`,
    python: `import httpx
resp = httpx.get("${BASE_URL}/v1/environments", headers={"x-api-key": KEY})
environments = resp.json()`,
    typescript: `const res = await fetch("${BASE_URL}/v1/environments", {
  headers: { "x-api-key": KEY },
});
const environments = await res.json();`,
  },
  get: {
    curl: `curl -H "x-api-key: $KEY" ${BASE_URL}/v1/environments/{id}`,
    python: `import httpx
resp = httpx.get("${BASE_URL}/v1/environments/{id}", headers={"x-api-key": KEY})
env = resp.json()`,
    typescript: `const res = await fetch("${BASE_URL}/v1/environments/{id}", {
  headers: { "x-api-key": KEY },
});
const env = await res.json();`,
  },
  delete: {
    curl: `curl -X DELETE -H "x-api-key: $KEY" ${BASE_URL}/v1/environments/{id}`,
    python: `import httpx
httpx.delete("${BASE_URL}/v1/environments/{id}", headers={"x-api-key": KEY})`,
    typescript: `await fetch("${BASE_URL}/v1/environments/{id}", {
  method: "DELETE",
  headers: { "x-api-key": KEY },
});`,
  },
};

// ─── secrets / vaults ─────────────────────────────────────────────────────────

const secrets: ResourceSnippets = {
  list: {
    curl: `curl -H "x-api-key: $KEY" ${BASE_URL}/v1/vaults`,
    python: `import httpx
resp = httpx.get("${BASE_URL}/v1/vaults", headers={"x-api-key": KEY})
vaults = resp.json()`,
    typescript: `const res = await fetch("${BASE_URL}/v1/vaults", {
  headers: { "x-api-key": KEY },
});
const vaults = await res.json();`,
  },
};

// ─── registry ─────────────────────────────────────────────────────────────────

export const snippetRegistry: Record<string, ResourceSnippets> = {
  agents,
  sessions,
  environments,
  secrets,
};

/**
 * Interpolate {id} placeholders with an actual resource ID.
 */
export function interpolate(template: string, id: string): string {
  return template.replace(/\{id\}/g, id);
}
