/**
 * sprites.dev REST client.
 *
 * All endpoints Bearer-authenticated. Per-operation timeouts via AbortSignal.
 * Checkpoint/restore consume the NDJSON progress stream and reject on an
 * `error` event. See https://docs.sprites.dev/api/v001-rc30/ for the spec.
 *
 * URL/auth pattern inspired by
 * 
 */
import { getConfig } from "../config";
import { ApiError } from "../errors";

export interface Sprite {
  name: string;
  status: "cold" | "warm" | "running";
  http_endpoint?: string;
  url_settings?: { auth: "public" | "sprite" };
  created_at?: string;
  updated_at?: string;
  last_started_at?: string | null;
  last_active_at?: string | null;
}

export interface ListSpritesResponse {
  sprites: Sprite[];
  has_more: boolean;
  next_continuation_token?: string | null;
}

export interface Checkpoint {
  id: string;
  comment?: string | null;
  created_at?: string;
}

function authHeaders(tokenOverride?: string): Record<string, string> {
  const token = tokenOverride ?? getConfig().spriteToken;
  if (!token) {
    throw new ApiError(
      500,
      "server_error",
      "SPRITE_TOKEN required \u2014 add to vault or .env",
    );
  }
  return { Authorization: `Bearer ${token}` };
}

function api(): string {
  return getConfig().spriteApi.replace(/\/+$/, "");
}

function signalFor(timeoutMs?: number): AbortSignal | undefined {
  const t = timeoutMs ?? getConfig().spriteTimeoutMs;
  if (!t) return undefined;
  return AbortSignal.timeout(t);
}

async function handleJson<T>(res: Response, op: string): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      res.status >= 500 ? 502 : 500,
      "server_error",
      `sprites.dev ${op} failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }
  return (await res.json()) as T;
}

async function consumeNdjsonProgress(res: Response, op: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(
      res.status >= 500 ? 502 : 500,
      "server_error",
      `sprites.dev ${op} failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as { type?: string; message?: string; error?: string };
        if (evt.type === "error") {
          throw new ApiError(502, "server_error", `${op}: ${evt.message || evt.error || "error"}`);
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        // ignore non-JSON progress lines
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sprite CRUD
// ---------------------------------------------------------------------------

export async function createSprite(input: {
  name: string;
  wait_for_capacity?: boolean;
  url_settings?: { auth?: "public" | "sprite" };
  tokenOverride?: string;
}): Promise<Sprite> {
  const res = await fetch(`${api()}/v1/sprites`, {
    method: "POST",
    headers: { ...authHeaders(input.tokenOverride), "content-type": "application/json" },
    body: JSON.stringify({ name: input.name, wait_for_capacity: input.wait_for_capacity, url_settings: input.url_settings }),
    signal: signalFor(),
  });
  return handleJson<Sprite>(res, "createSprite");
}

export async function getSprite(name: string): Promise<Sprite | null> {
  const res = await fetch(
    `${api()}/v1/sprites/${encodeURIComponent(name)}`,
    { headers: authHeaders(), signal: signalFor() },
  );
  if (res.status === 404) return null;
  return handleJson<Sprite>(res, "getSprite");
}

export async function deleteSprite(name: string, tokenOverride?: string): Promise<void> {
  const res = await fetch(
    `${api()}/v1/sprites/${encodeURIComponent(name)}`,
    { method: "DELETE", headers: authHeaders(tokenOverride), signal: signalFor() },
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new ApiError(502, "server_error", `deleteSprite: ${res.status} ${text.slice(0, 200)}`);
  }
}

export async function listSprites(opts: {
  prefix?: string;
  max_results?: number;
  continuation_token?: string;
} = {}): Promise<ListSpritesResponse> {
  const params = new URLSearchParams();
  if (opts.prefix) params.set("prefix", opts.prefix);
  if (opts.max_results != null) params.set("max_results", String(opts.max_results));
  if (opts.continuation_token) params.set("continuation_token", opts.continuation_token);
  const res = await fetch(
    `${api()}/v1/sprites?${params.toString()}`,
    { headers: authHeaders(), signal: signalFor() },
  );
  return handleJson<ListSpritesResponse>(res, "listSprites");
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export async function createCheckpoint(name: string, comment?: string): Promise<Checkpoint> {
  // create returns streaming NDJSON progress; the final message carries the id.
  const res = await fetch(
    `${api()}/v1/sprites/${encodeURIComponent(name)}/checkpoint`,
    {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ comment: comment ?? null }),
      signal: signalFor(getConfig().agentTimeoutMs),
    },
  );
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new ApiError(502, "server_error", `createCheckpoint: ${res.status} ${text.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let id: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as {
          type?: string;
          data?: string;
          message?: string;
          checkpoint_id?: string;
          id?: string;
        };
        if (evt.type === "error") {
          throw new ApiError(502, "server_error", `createCheckpoint: ${evt.data || evt.message || "error"}`);
        }
        // The API embeds the checkpoint ID in multiple places:
        //   - complete event: "Checkpoint v1 created successfully"
        //   - info event: "  ID: v1"
        // Try structured fields first, then parse from data strings.
        if (evt.checkpoint_id || evt.id) {
          id = evt.checkpoint_id || evt.id || null;
        }
        if (!id && evt.type === "info" && evt.data) {
          const idMatch = evt.data.match(/^\s*ID:\s*(.+)$/);
          if (idMatch) id = idMatch[1].trim();
        }
        if (!id && evt.type === "complete" && evt.data) {
          const ckptMatch = evt.data.match(/Checkpoint\s+(\S+)/);
          if (ckptMatch) id = ckptMatch[1];
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        // ignore non-JSON
      }
    }
  }
  if (!id) {
    throw new ApiError(502, "server_error", "createCheckpoint: no checkpoint id in progress stream");
  }
  return { id };
}

export async function restoreCheckpoint(name: string, checkpointId: string): Promise<void> {
  const res = await fetch(
    `${api()}/v1/sprites/${encodeURIComponent(name)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`,
    {
      method: "POST",
      headers: authHeaders(),
      signal: signalFor(getConfig().agentTimeoutMs),
    },
  );
  await consumeNdjsonProgress(res, "restoreCheckpoint");
}

// ---------------------------------------------------------------------------
// Exec (HTTP variant — for one-shot setup commands only)
// ---------------------------------------------------------------------------

/**
 * HTTP POST exec variant. Suitable only for non-streaming, non-interruptible
 * operations like setup-script execution. For normal turns and anything that
 * might be killed, use `lib/sprite/exec.ts` (WebSocket) instead.
 */
export async function httpExec(
  name: string,
  argv: string[],
  opts: { stdin?: string; timeoutMs?: number; tokenOverride?: string } = {},
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const params = new URLSearchParams();
  for (const c of argv) params.append("cmd", c);
  if (opts.stdin != null) params.set("stdin", "true");
  const res = await fetch(
    `${api()}/v1/sprites/${encodeURIComponent(name)}/exec?${params.toString()}`,
    {
      method: "POST",
      headers: authHeaders(opts.tokenOverride),
      body: opts.stdin ?? undefined,
      signal: signalFor(opts.timeoutMs ?? getConfig().agentTimeoutMs),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(502, "server_error", `httpExec: ${res.status} ${text.slice(0, 300)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return (await res.json()) as { stdout: string; stderr: string; exit_code: number };
  }
  const text = await res.text();
  return { stdout: text, stderr: "", exit_code: 0 };
}

export async function killExecSession(spriteName: string, execSessionId: string): Promise<void> {
  const res = await fetch(
    `${api()}/v1/sprites/${encodeURIComponent(spriteName)}/exec/${encodeURIComponent(execSessionId)}/kill`,
    { method: "POST", headers: authHeaders(), signal: signalFor() },
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new ApiError(502, "server_error", `killExecSession: ${res.status} ${text.slice(0, 200)}`);
  }
  // The kill endpoint also streams NDJSON progress; consume and discard.
  await consumeNdjsonProgress(res, "killExecSession").catch(() => {});
}
