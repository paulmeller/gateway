/**
 * M1 end-to-end smoke test against real sprites.dev + real claude.
 *
 * Requires SPRITE_TOKEN and CLAUDE_CODE_OAUTH_TOKEN in env (or .env).
 * Creates a fresh sprite, runs one turn through the full driver pipeline,
 * asserts the translated Managed Agents events land correctly, then cleans up.
 *
 * Run with: npx vitest run test/e2e-smoke.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";

// Load .env manually for test context
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

describe("M1 e2e smoke", () => {
  const SPRITE_TOKEN = process.env.SPRITE_TOKEN;
  const CLAUDE_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const SPRITE_API = process.env.SPRITE_API || "https://api.sprites.dev";
  const SPRITE_NAME = `ca-e2e-${Date.now()}`;

  if (!SPRITE_TOKEN || !CLAUDE_TOKEN) {
    it.skip("skipping e2e: SPRITE_TOKEN or CLAUDE_CODE_OAUTH_TOKEN not set", () => {});
    return;
  }

  const headers = { Authorization: `Bearer ${SPRITE_TOKEN}` };
  const spriteUrl = (p: string) =>
    `${SPRITE_API}/v1/sprites/${encodeURIComponent(SPRITE_NAME)}${p}`;

  beforeAll(async () => {
    // Create a fresh sprite
    const res = await fetch(`${SPRITE_API}/v1/sprites`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: SPRITE_NAME }),
    });
    expect(res.status).toBe(201);

    // Install the wrapper script via a simple heredoc
    const installCmd = [
      "cat > /home/sprite/.claude-wrapper << 'WRAPPER'",
      "#!/bin/bash",
      'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done',
      'exec claude "$@"',
      "WRAPPER",
      "chmod +x /home/sprite/.claude-wrapper",
    ].join("\n");
    const installRes = await fetch(
      spriteUrl(`/exec?cmd=bash&cmd=-c&cmd=${encodeURIComponent(installCmd)}`),
      { method: "POST", headers },
    );
    expect(installRes.ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    // Clean up
    await fetch(spriteUrl(""), { method: "DELETE", headers }).catch(() => {});
  }, 15_000);

  it("runs one turn of claude -p and produces valid NDJSON events", async () => {
    const { parseNDJSONLines } = await import("../src/backends/shared/ndjson");
    const { createClaudeTranslator: createTranslator } = await import(
      "../src/backends/claude/translator"
    );
    type TranslatedEvent = { type: string; payload: Record<string, unknown> };

    // Build the exec URL
    const argv = [
      "/home/sprite/.claude-wrapper",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "1",
    ];
    const params = new URLSearchParams();
    for (const c of argv) params.append("cmd", c);
    params.set("stdin", "true");

    const isOAuth = CLAUDE_TOKEN!.startsWith("sk-ant-oat");
    const envKey = isOAuth ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
    const stdinBody = `${envKey}=${CLAUDE_TOKEN}\n\nsay hello in exactly one word`;

    const res = await fetch(spriteUrl(`/exec?${params.toString()}`), {
      method: "POST",
      headers,
      body: stdinBody,
    });
    expect(res.ok).toBe(true);

    // Parse the raw output through our pipeline
    const rawText = await res.text();
    // Strip control chars from HTTP exec response (same issue opencompletions hits)
    const cleaned = rawText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

    const rawEvents: Array<Record<string, unknown>> = [];
    parseNDJSONLines(cleaned + "\n", (obj: Record<string, unknown>) => rawEvents.push(obj));

    console.log(
      "raw event types:",
      rawEvents.map((e) => e.type),
    );

    // At minimum we should see: system, assistant, result
    const types = rawEvents.map((e) => e.type);
    expect(types).toContain("system");
    expect(types).toContain("assistant");
    expect(types).toContain("result");

    // Translate through the translator
    const translator = createTranslator({
      customToolNames: new Set(),
      isFirstTurn: true,
    });
    const translated: TranslatedEvent[] = [];
    for (const raw of rawEvents) {
      for (const t of translator.translate(raw)) translated.push(t);
    }

    console.log(
      "translated event types:",
      translated.map((t) => t.type),
    );

    // Should have at least one agent.message
    expect(translated.some((t) => t.type === "agent.message")).toBe(true);

    // Check agent.message has the right shape
    const msg = translated.find((t) => t.type === "agent.message")!;
    expect(msg.payload).toHaveProperty("content");
    const content = msg.payload.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe("text");
    expect(content[0].text.length).toBeGreaterThan(0);

    // Check the result
    const turnResult = translator.getTurnResult();
    expect(turnResult).not.toBeNull();
    expect(turnResult!.stopReason).toBe("end_turn");
    expect(turnResult!.usage.input_tokens).toBeGreaterThan(0);

    // Session ID should be captured
    const sid = translator.getBackendSessionId();
    expect(sid).toBeTruthy();
    console.log("claude session_id:", sid);
  }, 60_000);
});
