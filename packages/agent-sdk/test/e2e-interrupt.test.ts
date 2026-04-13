/**
 * M3 end-to-end: interrupt a mid-flight turn.
 *
 * Sends a prompt that would take a long time (multiple bash commands with
 * sleeps), then sends `user.interrupt` after 3s and asserts that
 * `session.status_idle{stop_reason:"interrupted"}` arrives within 5s.
 *
 * After the interrupt, a follow-up `user.message` should produce a new turn
 * on the same sprite via `--resume`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

const PORT = Number(process.env.CA_TEST_PORT ?? 4102);
const BASE = `http://localhost:${PORT}`;

type ServerHandle = { proc: import("node:child_process").ChildProcess; apiKey: string };

async function bootServer(): Promise<ServerHandle> {
  const { spawn } = await import("node:child_process");
  const dbDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, `test-interrupt-${Date.now()}.db`);

  const proc = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    env: { ...process.env, DATABASE_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let apiKey = "";
  const onData = (buf: Buffer) => {
    const s = buf.toString("utf8");
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
  for (let i = 0; i < 20 && !apiKey; i++) await sleep(200);
  if (!apiKey) throw new Error("failed to obtain API key from server output");
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

describe("M3 interrupt e2e", () => {
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

  it("interrupts a long-running turn and emits status_idle{interrupted}", async () => {
    const key = server.apiKey;
    const H = { "x-api-key": key, "content-type": "application/json" };

    // Setup: agent + env + session
    const agent = (await (
      await fetch(`${BASE}/v1/agents`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          name: "interrupt-test",
          model: "claude-sonnet-4-6",
          tools: [{ type: "agent_toolset_20260401" }],
        }),
      })
    ).json()) as { id: string };

    const env = (await (
      await fetch(`${BASE}/v1/environments`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          name: "interrupt-env",
          config: { type: "cloud", networking: { type: "unrestricted" } },
        }),
      })
    ).json()) as { id: string };

    // Poll env ready
    let envState = "preparing";
    for (let i = 0; i < 30; i++) {
      const r = (await (
        await fetch(`${BASE}/v1/environments/${env.id}`, { headers: H })
      ).json()) as { state: string };
      envState = r.state;
      if (envState === "ready") break;
      if (envState === "failed") throw new Error("env setup failed");
      await sleep(1000);
    }
    expect(envState).toBe("ready");

    const session = (await (
      await fetch(`${BASE}/v1/sessions`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ agent: agent.id, environment_id: env.id }),
      })
    ).json()) as { id: string };
    const sid = session.id;

    // Stream collector
    const collected: Array<{ seq: number; type: string; [k: string]: unknown }> = [];
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
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const block of parts) {
            const m = block.match(/^data: (.+)$/m);
            if (!m) continue;
            try {
              const d = JSON.parse(m[1]) as { seq?: number; type: string };
              if (d.seq != null) collected.push(d as never);
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

    // Send a prompt that would take multiple seconds to complete
    // (asks claude to use Bash tool with sleep)
    await fetch(`${BASE}/v1/sessions/${sid}/events`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        events: [
          {
            type: "user.message",
            content: [
              {
                type: "text",
                text: "Run a bash command: `for i in 1 2 3 4 5 6 7 8 9 10; do echo step-$i; sleep 2; done` and tell me when all steps are done.",
              },
            ],
          },
        ],
      }),
    });

    // Wait for turn to actually start (status_running). Cold sprite + claude
    // startup can take up to ~30s.
    for (let i = 0; i < 60; i++) {
      const hist = await fetch(`${BASE}/v1/sessions/${sid}/events?limit=50`, { headers: H });
      const histData = (await hist.json()) as { data: Array<{ type: string; seq: number }> };
      if (histData.data.some((e) => e.type === "session.status_running")) break;
      if (i % 5 === 0) {
        console.log(
          `  poll ${i}s: history=${histData.data.map((d) => d.type).join(",")}`,
        );
      }
      await sleep(1000);
    }
    console.log("stream collected before interrupt:", collected.map((c) => c.type));
    expect(collected.some((e) => e.type === "session.status_running")).toBe(true);

    // Wait a bit more to be sure we're mid-flight (claude is thinking or running bash)
    await sleep(4000);

    // Send interrupt
    const beforeInterruptMs = Date.now();
    console.log("sending interrupt at", new Date().toISOString());
    await fetch(`${BASE}/v1/sessions/${sid}/events`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ events: [{ type: "user.interrupt" }] }),
    });

    // Wait for status_idle{interrupted} — should arrive within 5s
    let interruptedIdle: { seq: number; stop_reason?: string } | null = null;
    for (let i = 0; i < 20; i++) {
      const match = collected.find(
        (e) => e.type === "session.status_idle" && (e as { stop_reason?: string }).stop_reason === "interrupted",
      );
      if (match) {
        interruptedIdle = match as never;
        break;
      }
      await sleep(250);
    }
    const elapsedMs = Date.now() - beforeInterruptMs;
    console.log(`interrupt → status_idle{interrupted} elapsed: ${elapsedMs}ms`);

    expect(interruptedIdle).not.toBeNull();
    expect(elapsedMs).toBeLessThan(5000);

    // Send a follow-up user.message and verify a new turn runs cleanly
    await fetch(`${BASE}/v1/sessions/${sid}/events`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        events: [
          {
            type: "user.message",
            content: [{ type: "text", text: "Say hi in one word" }],
          },
        ],
      }),
    });

    // Wait for the second turn's status_idle (with stop_reason != interrupted)
    let secondIdle: { seq: number; stop_reason?: string } | null = null;
    for (let i = 0; i < 40; i++) {
      const idles = collected.filter(
        (e) => e.type === "session.status_idle" && (e as { stop_reason?: string }).stop_reason !== "interrupted",
      );
      if (idles.length > 0) {
        secondIdle = idles[0] as never;
        break;
      }
      await sleep(500);
    }
    expect(secondIdle).not.toBeNull();

    abortCtl.abort();
    await streamPromise.catch(() => {});

    console.log("final collected:", collected.map((c) => `${c.seq}:${c.type}`).join(" "));
  }, 300_000);
});
