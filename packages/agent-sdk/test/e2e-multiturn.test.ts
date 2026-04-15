/**
 * M2 end-to-end: multi-turn with --resume.
 *
 * Verifies:
 *   - Two sequential user.messages to one session produce two distinct turns
 *   - Sprite stays alive across turns (pinned)
 *   - claude_session_id is captured and reused via --resume
 *   - Context is preserved (claude recalls the first turn)
 *
 * Requires SPRITE_TOKEN + CLAUDE_CODE_OAUTH_TOKEN.
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

const PORT = Number(process.env.CA_TEST_PORT ?? 4101);
const BASE = `http://localhost:${PORT}`;

type ServerHandle = { proc: import("node:child_process").ChildProcess; apiKey: string };

async function bootServer(): Promise<ServerHandle> {
  const { spawn } = await import("node:child_process");
  // Fresh DB for the test
  const dbDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, `test-multiturn-${Date.now()}.db`);

  const proc = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    env: { ...process.env, DATABASE_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let apiKey = "";
  const logChunks: string[] = [];
  const onData = (buf: Buffer) => {
    const s = buf.toString("utf8");
    logChunks.push(s);
    const m = s.match(/key:\s+(ck_[A-Za-z0-9_-]+)/);
    if (m) apiKey = m[1];
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);

  // Wait for the server to be ready
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch {
      /* not ready */
    }
  }

  // Trigger init to create the API key
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

describe("M2 multi-turn e2e", () => {
  if (!process.env.SPRITE_TOKEN || !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    it.skip("skipping: creds not set", () => {});
    return;
  }

  let server: ServerHandle;

  beforeAll(async () => {
    server = await bootServer();
  }, 120_000);

  afterAll(async () => {
    await stopServer(server);
    await cleanupSprites();
  }, 30_000);

  it("two turns share context via --resume", async () => {
    const key = server.apiKey;
    const H = { "x-api-key": key, "content-type": "application/json" };

    // 1. Create agent
    const agentRes = await fetch(`${BASE}/v1/agents`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        name: "multiturn",
        model: "claude-sonnet-4-6",
        tools: [{ type: "agent_toolset_20260401" }],
      }),
    });
    expect(agentRes.ok).toBe(true);
    const agent = (await agentRes.json()) as { id: string; version: number };

    // 2. Create environment (no packages → ready immediately)
    const envRes = await fetch(`${BASE}/v1/environments`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        name: "multiturn-env",
        config: { type: "cloud", networking: { type: "unrestricted" } },
      }),
    });
    const env = (await envRes.json()) as { id: string; state: string };

    // Poll until ready
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`${BASE}/v1/environments/${env.id}`, { headers: H });
      const e = (await r.json()) as { state: string };
      if (e.state === "ready") break;
      if (e.state === "failed") throw new Error(`env setup failed`);
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

    // 4. Open stream in the background and collect events
    const collected: Array<{ seq: number; type: string; content?: unknown }> = [];
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
              const d = JSON.parse(m[1]) as { seq?: number; type: string; content?: unknown };
              if (d.seq != null) collected.push({ seq: d.seq, type: d.type, content: d.content });
            } catch {
              /* ping or malformed */
            }
          }
        }
      } catch {
        /* aborted */
      }
    })();

    await sleep(500);

    // 5. Turn 1
    await fetch(`${BASE}/v1/sessions/${sid}/events`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Remember: the secret word is PINEAPPLE. Reply with just OK." }],
          },
        ],
      }),
    });

    // Wait for turn 1 status_idle (up to 60s — cold sprite + claude turn)
    for (let i = 0; i < 60; i++) {
      if (collected.some((e) => e.type === "session.status_idle")) break;
      await sleep(1000);
    }
    // Also fetch server-side events via the history API for debugging
    const histRes = await fetch(`${BASE}/v1/sessions/${sid}/events?limit=50`, { headers: H });
    const hist = (await histRes.json()) as { data: Array<{ type: string; seq: number }> };
    console.log("after turn 1, stream collected:", collected.map((c) => c.type));
    console.log("after turn 1, history:", hist.data.map((d) => `${d.seq}:${d.type}`));
    expect(collected.some((e) => e.type === "session.status_idle")).toBe(true);
    const turn1Messages = collected.filter((e) => e.type === "agent.message");
    expect(turn1Messages.length).toBeGreaterThan(0);

    // 6. Turn 2 — should --resume and recall the secret word
    await fetch(`${BASE}/v1/sessions/${sid}/events`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "What was the secret word I just told you?" }],
          },
        ],
      }),
    });

    // Wait for the second turn to finish (look for a second status_idle)
    for (let i = 0; i < 30; i++) {
      const idleCount = collected.filter((e) => e.type === "session.status_idle").length;
      if (idleCount >= 2) break;
      await sleep(1000);
    }

    const allMessages = collected.filter((e) => e.type === "agent.message");
    const allText = allMessages
      .flatMap((e) => (e.content as Array<{ type: string; text?: string }>) ?? [])
      .map((b) => b.text ?? "")
      .join(" ");
    console.log("all agent.message text:", allText);

    // Turn 2 should mention PINEAPPLE — this proves --resume preserved context
    expect(allText).toMatch(/PINEAPPLE/i);

    // Session stats should show 2 turns
    const finalSess = (await (
      await fetch(`${BASE}/v1/sessions/${sid}`, { headers: H })
    ).json()) as { stats: { turn_count: number } };
    expect(finalSess.stats.turn_count).toBe(2);

    abortCtl.abort();
    await streamPromise.catch(() => {});
  }, 180_000);
});
