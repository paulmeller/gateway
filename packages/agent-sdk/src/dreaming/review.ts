/**
 * Dreaming — review recent sessions and curate a memory store.
 *
 * Calls the Anthropic Messages API directly (same pattern as grader.ts)
 * with a tool_use schema to produce structured memory operations.
 */
import { listSessions } from "../db/sessions";
import { listEvents } from "../db/events";
import { getMemoryStore, listMemories, createOrUpsertMemory, deleteMemory, getMemoryByPath } from "../db/memory";
import { nowMs } from "../util/clock";
import { DREAMING_SYSTEM_PROMPT, UPDATE_MEMORIES_TOOL } from "./prompts";

export interface DreamResult {
  sessionCount: number;
  proposedChanges: Array<{
    operation: "create" | "update" | "delete";
    path: string;
    content?: string;
    reason: string;
  }>;
  applied: boolean;
}

interface MemoryChange {
  operation: "create" | "update" | "delete";
  path: string;
  content?: string;
  reason: string;
}

const MAX_SESSIONS = 20;
const MAX_EVENTS_PER_SESSION = 50;
const RELEVANT_EVENT_TYPES = ["user.message", "agent.message", "session.error"];

/**
 * Extract a compact summary from a session's events.
 */
export function extractSessionSummary(
  sessionId: string,
  title: string | null,
  events: Array<{ type: string; payload_json: string }>,
): string {
  const parts: string[] = [];
  const errors: string[] = [];

  for (const evt of events) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(evt.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (evt.type === "user.message") {
      const content = payload.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b: { type?: string }) => b.type === "text")
          .map((b: { text?: string }) => b.text ?? "")
          .join(" ");
        if (text) parts.push(`[User] ${text.slice(0, 500)}`);
      } else if (typeof content === "string") {
        parts.push(`[User] ${content.slice(0, 500)}`);
      }
    } else if (evt.type === "agent.message") {
      const content = payload.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b: { type?: string }) => b.type === "text")
          .map((b: { text?: string }) => b.text ?? "")
          .join(" ");
        if (text) parts.push(`[Agent] ${text.slice(0, 500)}`);
      } else if (typeof content === "string") {
        parts.push(`[Agent] ${content.slice(0, 500)}`);
      }
    } else if (evt.type === "session.error") {
      const msg = (payload.message as string) ?? (payload.error as string) ?? JSON.stringify(payload);
      errors.push(msg.slice(0, 200));
    }
  }

  const header = `Session ${sessionId}${title ? ` (${title})` : ""}:`;
  const body = parts.join("\n");
  const errorSection = errors.length ? `\nErrors: ${errors.join("; ")}` : "";
  return `${header}\n${body}${errorSection}`;
}

/**
 * Review recent sessions and propose memory store changes.
 */
export async function reviewSessions(opts: {
  storeId: string;
  lookbackMs: number;
  dryRun: boolean;
  apiKey?: string;
  model?: string;
}): Promise<DreamResult> {
  const { storeId, lookbackMs, dryRun } = opts;

  // 1. Validate the memory store exists
  const store = getMemoryStore(storeId);
  if (!store) {
    throw new Error(`Memory store not found: ${storeId}`);
  }

  // 2. Resolve API key
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("No Anthropic API key provided. Use --api-key or set ANTHROPIC_API_KEY.");
  }

  // 3. Query sessions completed in lookback window
  const cutoff = nowMs() - lookbackMs;
  const sessions = listSessions({
    statuses: ["idle", "terminated"],
    createdGt: cutoff,
    limit: MAX_SESSIONS,
    order: "desc",
  });

  if (sessions.length === 0) {
    return { sessionCount: 0, proposedChanges: [], applied: false };
  }

  // 4. Extract events and build summaries
  const summaries: string[] = [];
  for (const session of sessions) {
    const events = listEvents(session.id, {
      limit: MAX_EVENTS_PER_SESSION,
      order: "asc",
    });

    // Filter to relevant event types
    const relevant = events.filter((e) => RELEVANT_EVENT_TYPES.includes(e.type));
    if (relevant.length === 0) continue;

    const summary = extractSessionSummary(session.id, session.title ?? null, relevant);
    summaries.push(summary);
  }

  if (summaries.length === 0) {
    return { sessionCount: sessions.length, proposedChanges: [], applied: false };
  }

  // 5. Load current memories
  const memories = listMemories(storeId);
  const memorySection = memories.length > 0
    ? `## Current Memory Store Contents\n\n${memories.map((m) => `### ${m.path}\n${m.content}`).join("\n\n")}`
    : "## Current Memory Store Contents\n\n(empty — no memories yet)";

  // 6. Build the user message
  const sessionSection = `## Recent Sessions (${summaries.length})\n\n${summaries.join("\n\n---\n\n")}`;
  const userMessage = `${sessionSection}\n\n${memorySection}\n\nAnalyze the sessions above and propose memory changes using the update_memories tool.`;

  // Truncate if too long (rough ~50K token estimate at 4 chars/token)
  const maxChars = 200_000;
  const truncatedMessage = userMessage.length > maxChars
    ? userMessage.slice(0, maxChars) + "\n\n[... truncated for context limits]"
    : userMessage;

  // 7. Call Anthropic API
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model || "claude-sonnet-4-6",
      max_tokens: 4096,
      system: DREAMING_SYSTEM_PROMPT,
      tools: [UPDATE_MEMORIES_TOOL],
      tool_choice: { type: "tool", name: "update_memories" },
      messages: [{ role: "user", content: truncatedMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Anthropic API error (${response.status}): ${errText}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; name?: string; input?: { changes?: MemoryChange[] } }>;
  };

  // 8. Parse tool_use response
  const toolUse = data.content.find(
    (b) => b.type === "tool_use" && b.name === "update_memories",
  );

  const changes: MemoryChange[] = toolUse?.input?.changes ?? [];

  // 9. Apply if not dry-run
  if (!dryRun && changes.length > 0) {
    for (const change of changes) {
      if (change.operation === "create" || change.operation === "update") {
        if (change.content) {
          createOrUpsertMemory(storeId, change.path, change.content, "dream");
        }
      } else if (change.operation === "delete") {
        const existing = getMemoryByPath(storeId, change.path);
        if (existing) {
          deleteMemory(existing.id, "dream");
        }
      }
    }
  }

  return {
    sessionCount: sessions.length,
    proposedChanges: changes,
    applied: !dryRun && changes.length > 0,
  };
}
