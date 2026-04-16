/**
 * sprites.dev exec client.
 *
 * Uses HTTP POST exec rather than WebSocket exec because the sprites.dev
 * WebSocket protocol does not support stdin EOF delivery for processes that
 * read to EOF (e.g. `claude`). HTTP POST handles stdin cleanly: the request
 * body is the stdin and the connection close signals EOF.
 *
 * Interrupts are implemented by aborting the HTTP fetch. This gives clean
 * client-visible semantics (session.status_idle{stop_reason: interrupted}
 * is emitted within milliseconds) even though the sprite-side process may
 * run to its natural completion.
 *
 * If sprites.dev later publishes a WS stdin protocol or a kill-by-name
 * HTTP endpoint, the kill path can be upgraded without touching the
 * driver — it's all behind the ExecSession interface.
 */
import { getConfig } from "../config";
import { ApiError } from "../errors";

export interface ExecResult {
  code: number;
}

export interface ExecSession {
  /** Readable stream of raw stdout bytes (HTTP streaming body) */
  stdout: ReadableStream<Uint8Array>;
  /** Resolves when the exec finishes */
  exit: Promise<ExecResult>;
  /** Best-effort kill — aborts the HTTP fetch */
  kill(): Promise<void>;
  /** Server-issued exec session id (not available for HTTP exec) */
  execSessionId?: string;
}

export interface ExecOptions {
  argv: string[];
  stdin?: string;
  /** Signal that, when aborted, cancels the exec */
  signal?: AbortSignal;
  /** Timeout in ms for the whole exec (defaults to config.agentTimeoutMs) */
  timeoutMs?: number;
  /** Vault secrets for provider auth override */
  secrets?: Record<string, string>;
}

function api(): string {
  return getConfig().spriteApi.replace(/\/+$/, "");
}

function authHeaders(tokenOverride?: string): Record<string, string> {
  const token = tokenOverride ?? getConfig().spriteToken;
  if (!token) {
    throw new ApiError(500, "server_error", "SPRITE_TOKEN required \u2014 add to vault or .env");
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * Start a streaming HTTP exec on a sprite. The `argv` becomes `?cmd=a&cmd=b...`
 * query params; stdin (if any) is posted as the request body; the response
 * body is the streamed stdout.
 *
 * When the AbortSignal fires, the underlying fetch is aborted — the HTTP
 * connection closes from our side, which the driver treats as an interrupted
 * turn. The sprite-side process is unaffected; it will finish naturally.
 */
export async function startExec(
  spriteName: string,
  opts: ExecOptions,
): Promise<ExecSession> {
  const params = new URLSearchParams();
  for (const c of opts.argv) params.append("cmd", c);
  if (opts.stdin != null) params.set("stdin", "true");

  const localAbort = new AbortController();
  const timeoutMs = opts.timeoutMs ?? getConfig().agentTimeoutMs;
  const timeoutId = setTimeout(
    () => localAbort.abort(new DOMException("exec timeout", "AbortError")),
    timeoutMs,
  );

  // Link caller's signal to our internal abort
  if (opts.signal) {
    if (opts.signal.aborted) localAbort.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", () => localAbort.abort(opts.signal!.reason));
  }

  const res = await fetch(
    `${api()}/v1/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`,
    {
      method: "POST",
      headers: authHeaders(opts.secrets?.SPRITE_TOKEN),
      body: opts.stdin ?? undefined,
      signal: localAbort.signal,
    },
  );

  if (!res.ok) {
    clearTimeout(timeoutId);
    const text = await res.text().catch(() => "");
    throw new ApiError(
      502,
      "server_error",
      `sprite exec failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  if (!res.body) {
    clearTimeout(timeoutId);
    throw new ApiError(502, "server_error", "sprite exec returned no body");
  }

  let exitResolve: (v: ExecResult) => void = () => {};
  let exitReject: (e: unknown) => void = () => {};
  const exit = new Promise<ExecResult>((resolve, reject) => {
    exitResolve = resolve;
    exitReject = reject;
  });

  // Tee the body: one side goes to the consumer, the other is a watcher that
  // resolves `exit` when the stream ends or rejects on abort.
  const [consumerStream, watchStream] = res.body.tee();

  (async () => {
    const reader = watchStream.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      exitResolve({ code: 0 });
    } catch (err) {
      if (localAbort.signal.aborted) {
        exitReject(new DOMException("aborted", "AbortError"));
      } else {
        exitReject(err);
      }
    } finally {
      clearTimeout(timeoutId);
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  })();

  return {
    stdout: consumerStream,
    exit,
    async kill() {
      localAbort.abort(new DOMException("killed", "AbortError"));
    },
  };
}
