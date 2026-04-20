/**
 * RemoteBackend — HTTP fetch client against a running MA server.
 */
import type { Backend, Paginated } from "./interface.js";

export class RemoteBackend implements Backend {
  verbose = false;

  constructor(
    private baseURL: string,
    private apiKey: string,
  ) {
    this.baseURL = baseURL.replace(/\/$/, "");
  }

  async init(): Promise<void> {
    // No-op — remote server handles its own init
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.baseURL}${path}`;
    const headers: Record<string, string> = { "x-api-key": this.apiKey };
    const opts: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    const text = await res.text();

    if (!res.ok) {
      let msg = text;
      try {
        const err = JSON.parse(text);
        if (err?.error?.message) msg = `${err.error.type}: ${err.error.message}`;
      } catch {}
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }

    return text ? JSON.parse(text) : null;
  }

  agents = {
    create: (input: any) => this.request("POST", "/v1/agents", input),
    list: (opts?: any): Promise<Paginated<any>> => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.order) params.set("order", opts.order);
      if (opts?.include_archived) params.set("include_archived", "true");
      return this.request("GET", `/v1/agents?${params}`);
    },
    get: (id: string, version?: number) => {
      const q = version ? `?version=${version}` : "";
      return this.request("GET", `/v1/agents/${id}${q}`);
    },
    update: (id: string, input: any) => this.request("POST", `/v1/agents/${id}`, input),
    delete: (id: string) => this.request("DELETE", `/v1/agents/${id}`),
  };

  environments = {
    create: (input: any) => this.request("POST", "/v1/environments", input),
    list: (opts?: any): Promise<Paginated<any>> => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.order) params.set("order", opts.order);
      if (opts?.include_archived) params.set("include_archived", "true");
      return this.request("GET", `/v1/environments?${params}`);
    },
    get: (id: string) => this.request("GET", `/v1/environments/${id}`),
    delete: (id: string) => this.request("DELETE", `/v1/environments/${id}`),
    archive: (id: string) => this.request("POST", `/v1/environments/${id}/archive`),
  };

  sessions = {
    create: (input: any) => this.request("POST", "/v1/sessions", input),
    list: (opts?: any): Promise<Paginated<any>> => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.order) params.set("order", opts.order);
      if (opts?.agent_id) params.set("agent_id", opts.agent_id);
      if (opts?.environment_id) params.set("environment_id", opts.environment_id);
      if (opts?.status) params.set("status", opts.status);
      if (opts?.include_archived) params.set("include_archived", "true");
      return this.request("GET", `/v1/sessions?${params}`);
    },
    get: (id: string) => this.request("GET", `/v1/sessions/${id}`),
    update: (id: string, input: any) => this.request("POST", `/v1/sessions/${id}`, input),
    delete: (id: string) => this.request("DELETE", `/v1/sessions/${id}`),
    archive: (id: string) => this.request("POST", `/v1/sessions/${id}/archive`),
    threads: (id: string, opts?: any): Promise<Paginated<any>> => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      return this.request("GET", `/v1/sessions/${id}/threads?${params}`);
    },
  };

  events = {
    send: (sessionId: string, events: any[]) =>
      this.request("POST", `/v1/sessions/${sessionId}/events`, { events }),
    list: (sessionId: string, opts?: any): Promise<Paginated<any>> => {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.order) params.set("order", opts.order);
      if (opts?.after_seq) params.set("after_seq", String(opts.after_seq));
      return this.request("GET", `/v1/sessions/${sessionId}/events?${params}`);
    },
    stream: (sessionId: string, afterSeq?: number): AsyncIterable<any> => {
      return this.streamSSEWithReconnect(sessionId, afterSeq);
    },
  };

  private async *streamSSEWithReconnect(sessionId: string, afterSeq?: number): AsyncGenerator<any> {
    let lastSeq = afterSeq;
    let backoff = 1000;
    const maxBackoff = 30_000;
    const maxRetries = 10;
    let retries = 0;

    while (retries <= maxRetries) {
      try {
        let gotEvents = false;
        for await (const evt of this.streamSSEOnce(sessionId, lastSeq)) {
          gotEvents = true;
          retries = 0;
          backoff = 1000;
          if (evt.seq != null) lastSeq = evt.seq;
          yield evt;
        }
        // Stream ended cleanly (server closed connection)
        if (!gotEvents) return; // Empty stream = nothing to reconnect for
      } catch (err) {
        // Connection error — retry
      }

      retries++;
      if (retries > maxRetries) return;
      console.error(`[reconnecting in ${backoff / 1000}s...]`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }

  private async *streamSSEOnce(sessionId: string, afterSeq?: number): AsyncGenerator<any> {
    const params = afterSeq != null ? `?after_seq=${afterSeq}` : "";
    const url = `${this.baseURL}/v1/sessions/${sessionId}/events/stream${params}`;
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      Accept: "text/event-stream",
    };
    if (afterSeq != null) {
      headers["Last-Event-ID"] = String(afterSeq);
    }

    const res = await fetch(url, { headers });
    if (!res.ok || !res.body) throw new Error(`SSE stream failed: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentData = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!; // keep incomplete line

        for (const line of lines) {
          if (line === "") {
            // Event boundary
            if (currentData) {
              try {
                const parsed = JSON.parse(currentData);
                if (parsed.type !== "ping") yield parsed;
              } catch (err) {
                if (this.verbose) {
                  console.error(`[sse] failed to parse event data: ${currentData.slice(0, 100)}`);
                }
              }
            }
            currentData = "";
          } else if (line.startsWith("data: ")) {
            if (currentData) currentData += "\n";
            currentData += line.slice(6);
          }
          // Skip id: and event: lines (we parse from data)
        }
      }
      // Flush any remaining data after stream ends
      if (currentData) {
        try {
          const parsed = JSON.parse(currentData);
          if (parsed.type !== "ping") yield parsed;
        } catch {}
      }
    } finally {
      reader.releaseLock();
    }
  }

  vaults = {
    create: (input: any) => this.request("POST", "/v1/vaults", input),
    list: (opts?: any) => {
      const params = new URLSearchParams();
      if (opts?.agent_id) params.set("agent_id", opts.agent_id);
      return this.request("GET", `/v1/vaults?${params}`);
    },
    get: (id: string) => this.request("GET", `/v1/vaults/${id}`),
    delete: (id: string) => this.request("DELETE", `/v1/vaults/${id}`),
    entries: {
      list: (vaultId: string) => this.request("GET", `/v1/vaults/${vaultId}/entries`),
      get: (vaultId: string, key: string) => this.request("GET", `/v1/vaults/${vaultId}/entries/${key}`),
      set: (vaultId: string, key: string, value: string) => this.request("PUT", `/v1/vaults/${vaultId}/entries/${key}`, { value }),
      delete: (vaultId: string, key: string) => this.request("DELETE", `/v1/vaults/${vaultId}/entries/${key}`),
    },
  };

  memory = {
    stores: {
      create: (input: any) => this.request("POST", "/v1/memory_stores", input),
      list: () => this.request("GET", "/v1/memory_stores"),
      get: (id: string) => this.request("GET", `/v1/memory_stores/${id}`),
      delete: (id: string) => this.request("DELETE", `/v1/memory_stores/${id}`),
    },
    memories: {
      create: (storeId: string, input: any) => this.request("POST", `/v1/memory_stores/${storeId}/memories`, input),
      list: (storeId: string) => this.request("GET", `/v1/memory_stores/${storeId}/memories`),
      get: (storeId: string, memId: string) => this.request("GET", `/v1/memory_stores/${storeId}/memories/${memId}`),
      update: (storeId: string, memId: string, input: any) => this.request("PATCH", `/v1/memory_stores/${storeId}/memories/${memId}`, input),
      delete: (storeId: string, memId: string) => this.request("DELETE", `/v1/memory_stores/${storeId}/memories/${memId}`),
    },
  };

  batch = {
    execute: (operations: any[]) => this.request("POST", "/v1/batch", { operations }),
  };

  skills = {
    search: (opts: { q?: string; sort?: string; limit?: number; offset?: number; source?: string }) => {
      const params = new URLSearchParams();
      if (opts.q) params.set("q", opts.q);
      if (opts.sort) params.set("sort", opts.sort);
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.offset) params.set("offset", String(opts.offset));
      if (opts.source) params.set("source", opts.source);
      return this.request("GET", `/v1/skills?${params}`);
    },
    stats: () => this.request("GET", "/v1/skills/stats"),
    sources: (opts?: { limit?: number }) =>
      this.request("GET", `/v1/skills/sources${opts?.limit ? `?limit=${opts.limit}` : ""}`),
  };

  providers = {
    status: async () => {
      const res = await this.request("GET", "/v1/providers/status");
      return res.data;
    },
  };
}
