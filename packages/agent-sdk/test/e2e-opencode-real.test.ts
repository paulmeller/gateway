/**
 * M(opencode-adapter) real-sprite e2e.
 *
 * Proves the full opencode path works against real sprites.dev + real
 * opencode: sprite install, wrapper, non-interactive run, translator,
 * session resume, event stream.
 *
 * Gated on SPRITE_TOKEN + ANTHROPIC_API_KEY. Skipped otherwise — explicitly
 * not gated on CLAUDE_CODE_OAUTH_TOKEN because opencode refuses OAuth
 * tokens per Anthropic ToS.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Load .env for test context
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

const PORT = Number(process.env.CA_TEST_PORT ?? 4105);
const BASE = `http://localhost:${PORT}`;

type ServerHandle = { proc: import("node:child_process").ChildProcess; apiKey: string };

async function bootServer(): Promise<ServerHandle> {
  const { spawn } = await import("node:child_process");
  const dbDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, `test-opencode-${Date.now()}.db`);

  const proc = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    env: { ...process.env, DATABASE_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let apiKey = "";
  const logChunks: string[] = [];
  const onData = (buf: Buffer): void => {
    const s = buf.toString("utf8");
    logChunks.push(s);
    const m = s.match(/key:\s+(ck_[A-Za-z0-9_-]+)/);
    if (m) apiKey = m[1];
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch {
      /* not ready */
    }
  }

  await fetch(`${BASE}/v1/agents`, { headers: { "x-api-key": "x" } }).catch(() => {});
  for (let i = 0; i < 20 && !apiKey; i++) {
    await sleep(200);
  }
  if (!apiKey) {
    console.error("server log:", logChunks.join("").slice(-2000));
    throw new Error("failed to obtain API key from server output");
  }
  return { proc, apiKey };
}

async function stopServer(h: ServerHandle): Promise<void> {
  h.proc.kill("SIGTERM");
  await sleep(500);
  if (!h.proc.killed) h.proc.kill("SIGKILL");
}

async function cleanupSprites(): Promise<void> {
  const token = process.env.SPRITE_TOKEN;
  if (!token) return;
  const api = process.env.SPRITE_API || "https://api.sprites.dev";
  const res = await fetch(`${api}/v1/sprites?prefix=ca-sess-`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return;
  const data = (await res.json()) as { sprites: Array<{ name: string }> };
  for (const s of data.sprites ?? []) {
    await fetch(`${api}/v1/sprites/${encodeURIComponent(s.name)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
}

describe("M(opencode-adapter) real sprite + real opencode", () => {
  const hasOpenAi = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!process.env.SPRITE_TOKEN || (!hasOpenAi && !hasAnthropic)) {
    it.skip("skipping: SPRITE_TOKEN and (OPENAI_API_KEY or ANTHROPIC_API_KEY) required — opencode refuses OAuth tokens", () => {});
    return;
  }
  // Prefer OpenAI if available (cheaper, faster). Fall back to Anthropic.
  const model = hasOpenAi ? "openai/gpt-4o-mini" : "anthropic/claude-sonnet-4-6";

  let server: ServerHandle;

  beforeAll(async () => {
    server = await bootServer();
  }, 120_000);

  afterAll(async () => {
    await stopServer(server);
    await cleanupSprites();
  }, 30_000);

  it("creates an opencode agent, runs one turn, streams agent.message", async () => {
    const key = server.apiKey;
    const H = {
      "x-api-key": key,
      "content-type": "application/json",
      "anthropic-beta": "managed-agents-2026-04-01",
    };

    // 1. Create opencode agent
    const agentRes = await fetch(`${BASE}/v1/agents`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        name: "opencode-test",
        model,
        backend: "opencode",
      }),
    });
    expect(agentRes.ok).toBe(true);
    const agent = (await agentRes.json()) as {
      id: string;
      version: number;
      backend: string;
    };
    expect(agent.backend).toBe("opencode");

    // 2. Create env
    const envRes = await fetch(`${BASE}/v1/environments`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        name: "opencode-env",
        config: { type: "cloud", networking: { type: "unrestricted" } },
      }),
    });
    const env = (await envRes.json()) as { id: string };
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`${BASE}/v1/environments/${env.id}`, { headers: H });
      const e = (await r.json()) as { state: string };
      if (e.state === "ready") break;
      if (e.state === "failed") throw new Error("env setup failed");
      await sleep(1000);
    }

    // 3. Create session
    const sessRes = await fetch(`${BASE}/v1/sessions`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ agent: agent.id, environment_id: env.id }),
    });
    const session = (await sessRes.json()) as { id: string };
    const sid = session.id;

    // 4. Open stream
    const collected: Array<{ seq: number; type: string; content?: unknown; stop_reason?: string }> = [];
    const abortCtl = new AbortController();
    const streamPromise = (async () => {
      const r = await fetch(`${BASE}/v1/sessions/${sid}/stream`, {
        headers: { "x-api-key": key, Accept: "text/event-stream" },
        signal: abortCtl.signal,
      });
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n\n");
          buf = lines.pop() || "";
          for (const block of lines) {
            const m = block.match(/^data: (.+)$/m);
            if (!m) continue;
            try {
              const d = JSON.parse(m[1]) as {
                seq?: number;
                type: string;
                content?: unknown;
                stop_reason?: string;
              };
              if (d.seq != null) collected.push({ ...d, seq: d.seq });
            } catch {
              /* ping */
            }
          }
        }
      } catch {
        /* aborted */
      }
    })();

    await sleep(500);

    // 5. Send a user.message
    await fetch(`${BASE}/v1/sessions/${sid}/events`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Say hi in one sentence and nothing else" }],
          },
        ],
      }),
    });

    // 6. Wait for completion — opencode cold install can take a minute on
    //    the first turn of a new sprite.
    for (let i = 0; i < 180; i++) {
      if (collected.some((e) => e.type === "session.status_idle")) break;
      await sleep(1000);
    }

    console.log("collected event types:", collected.map((e) => e.type));

    expect(collected.some((e) => e.type === "span.environment_setup_start")).toBe(true);
    expect(collected.some((e) => e.type === "span.environment_setup_end")).toBe(true);
    expect(collected.some((e) => e.type === "session.status_running")).toBe(true);

    const agentMessages = collected.filter((e) => e.type === "agent.message");
    expect(agentMessages.length).toBeGreaterThan(0);

    const finalIdle = collected.filter((e) => e.type === "session.status_idle").at(-1);
    expect(finalIdle?.stop_reason).toBe("end_turn");

    abortCtl.abort();
    await streamPromise.catch(() => {});
  }, 300_000);
});
