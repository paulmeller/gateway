/**
 * Turn driver — orchestrates one turn of a backend CLI against a sprite.
 *
 * Backend-agnostic: resolves the agent's `backend` field via the registry
 * and delegates argv/env/stdin construction + stream translation to the
 * concrete backend (claude, opencode, ...). The driver owns sprite
 * acquisition, the stream loop, event bus appends, and usage persistence.
 *
 * Flow:
 *   1. Validate runtime config for the backend (fail fast before sprite).
 *   2. Lazy-acquire the sprite if the session has none yet.
 *   3. Mark each pending user.message as processed (processed_at = now).
 *   4. Flip session status to "running", append `session.status_running`
 *      and `span.model_request_start`.
 *   5. Call backend.buildTurn → argv + env + stdin. Compose the wrapper
 *      stdin body as `envLines \n\n stdin`.
 *   6. Spawn exec on the sprite.
 *   7. Stream NDJSON through the translator, batch-append events per chunk.
 *   8. On successful exit: append `span.model_request_end`, update columnar
 *      usage, persist the latest backend session id, append
 *      `session.status_idle`.
 *   9. On abort: append `session.status_idle{stop_reason:"interrupted"}`.
 *  10. On error: append `session.error` + flip to idle/error.
 *  11. Drain any `pendingUserInputs` accumulated during the turn — they
 *      are enqueued as the next turn.
 */
import { appendEventsBatch, appendEvent } from "./bus";
import { getRuntime, drainPendingUserInputs, type TurnInput } from "../state";
import { getSession, setBackendSessionId, updateSessionStatus, updateSessionMutable, bumpSessionStats, setIdleSince, getSessionRow, getOutcomeCriteria, setOutcomeCriteria } from "../db/sessions";
import { getAgent } from "../db/agents";
import { getEnvironment } from "../db/environments";
import { markUserEventProcessed, listEvents } from "../db/events";
import { acquireForFirstTurn } from "../sprite/lifecycle";
import * as pool from "../sprite/pool";
import { resolveBackend } from "../backends/registry";
import { resolveContainerProvider } from "../providers/registry";
import { BLOCKED_ENV_KEYS } from "../providers/resolve-secrets";
import { listEntries as listVaultEntries } from "../db/vaults";
import { parseNDJSONLines } from "../backends/shared/ndjson";
import type { TranslatedEvent } from "../backends/shared/translator-types";
import type { Agent } from "../types";
import type { ContainerProvider } from "../providers/types";
import { resolveToolset } from "./tools";
import { ApiError } from "../errors";
import { nowMs } from "../util/clock";
import {
  PERMISSION_BRIDGE_PENDING_PATH,
  PERMISSION_BRIDGE_REQUEST_PATH,
  PERMISSION_BRIDGE_RESPONSE_PATH,
} from "../backends/claude/permission-hook";

export async function runTurn(
  sessionId: string,
  inputs: TurnInput[],
  _depth = 0,
): Promise<void> {
  if (_depth > 25) {
    appendEvent(sessionId, { type: "session.error", payload: { error: { type: "server_error", message: "max recursion depth exceeded" } }, origin: "server", processedAt: nowMs() });
    updateSessionStatus(sessionId, "idle", "error");
    return;
  }
  const session = getSession(sessionId);
  if (!session) return; // session was deleted between enqueue and run
  if (inputs.length === 0) return;

  const agent = getAgent(session.agent.id, session.agent.version);
  if (!agent) {
    appendEvent(sessionId, {
      type: "session.error",
      payload: { error: { type: "server_error", message: "agent not found" } },
      origin: "server",
      processedAt: nowMs(),
    });
    appendEvent(sessionId, {
      type: "session.status_idle",
      payload: { stop_reason: "error" },
      origin: "server",
      processedAt: nowMs(),
    });
    updateSessionStatus(sessionId, "idle", "error");
    return;
  }

  const backend = resolveBackend(agent.engine);

  // Belt-and-braces runtime validation. Config may have changed since the
  // agent was created (env vars cleared, settings table mutated). Fail fast
  // BEFORE sprite acquire / install so a 3-minute install isn't wasted on a
  // misconfigured backend.
  // Skip if session has vault entries — they provide keys at container level.
  let hasVaultKeys = false;
  if (session.vault_ids && session.vault_ids.length > 0) {
    console.log(`[driver] session ${sessionId} has vault_ids:`, session.vault_ids);
    for (const vid of session.vault_ids) {
      const entries = listVaultEntries(vid);
      console.log(`[driver] vault ${vid} has ${entries.length} entries`);
      if (entries.length > 0) { hasVaultKeys = true; break; }
    }
  } else {
    console.log(`[driver] session ${sessionId} has no vault_ids`);
  }
  if (!hasVaultKeys) {
    const runtimeErr = backend.validateRuntime?.();
    if (runtimeErr) {
      appendEvent(sessionId, {
        type: "session.error",
        payload: { error: { type: "invalid_request_error", message: runtimeErr } },
        origin: "server",
        processedAt: nowMs(),
      });
      appendEvent(sessionId, {
        type: "session.status_idle",
        payload: { stop_reason: "error" },
        origin: "server",
        processedAt: nowMs(),
      });
      updateSessionStatus(sessionId, "idle", "error");
      return;
    }
  }

  // Budget check: if max_budget_usd is set and usage has exceeded it, refuse the turn
  const budgetRow = getSessionRow(sessionId);
  if (budgetRow?.max_budget_usd != null && budgetRow.usage_cost_usd >= budgetRow.max_budget_usd) {
    appendEvent(sessionId, {
      type: "session.error",
      payload: { error: { type: "budget_exceeded", message: `usage $${budgetRow.usage_cost_usd.toFixed(4)} >= budget $${budgetRow.max_budget_usd.toFixed(4)}` } },
      origin: "server",
      processedAt: nowMs(),
    });
    appendEvent(sessionId, {
      type: "session.status_idle",
      payload: { stop_reason: "error" },
      origin: "server",
      processedAt: nowMs(),
    });
    updateSessionStatus(sessionId, "idle", "error");
    return;
  }

  // Mark each pending input as processed-now
  for (const p of inputs) markUserEventProcessed(p.eventId, nowMs());

  // Acquire sprite if needed
  console.log(`[driver] ${sessionId} acquiring container...`);
  let spriteName: string;
  try {
    spriteName = await acquireForFirstTurn(sessionId);
    console.log(`[driver] ${sessionId} container ready: ${spriteName}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendEvent(sessionId, {
      type: "session.error",
      payload: { error: { type: "server_error", message: `container creation failed: ${msg}` } },
      origin: "server",
      processedAt: nowMs(),
    });
    appendEvent(sessionId, {
      type: "session.status_idle",
      payload: { stop_reason: "error" },
      origin: "server",
      processedAt: nowMs(),
    });
    updateSessionStatus(sessionId, "idle", "error");
    return;
  }

  // Flip running + emit status_running + span start
  updateSessionStatus(sessionId, "running");
  const turnStartMs = nowMs();
  appendEvent(sessionId, {
    type: "session.status_running",
    payload: {},
    origin: "server",
    processedAt: turnStartMs,
  });
  appendEvent(sessionId, {
    type: "span.model_request_start",
    payload: { model: agent.model },
    origin: "server",
    processedAt: turnStartMs,
  });

  // Build argv + env + stdin via the backend. buildTurn may throw an
  // ApiError (e.g. opencode rejects tool_result re-entry) — catch, surface
  // as session.error + status_idle{error}.
  const promptText = inputs
    .filter((i): i is Extract<TurnInput, { kind: "text" }> => i.kind === "text")
    .map((i) => i.text)
    .join("\n\n");
  const toolResults = inputs
    .filter((i): i is Extract<TurnInput, { kind: "tool_result" }> => i.kind === "tool_result")
    .map((i) => ({
      custom_tool_use_id: i.custom_tool_use_id,
      content: i.content,
    }));

  let turnBuild;
  try {
    turnBuild = backend.buildTurn({
      agent,
      backendSessionId: getSessionRow(sessionId)?.claude_session_id ?? null,
      promptText,
      toolResults,
    });
  } catch (err) {
    const msg =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    const type = err instanceof ApiError ? err.type : "server_error";
    appendEvent(sessionId, {
      type: "session.error",
      payload: { error: { type, message: msg } },
      origin: "server",
      processedAt: nowMs(),
    });
    appendEvent(sessionId, {
      type: "session.status_idle",
      payload: { stop_reason: "error" },
      origin: "server",
      processedAt: nowMs(),
    });
    updateSessionStatus(sessionId, "idle", "error");
    return;
  }

  console.log(`[driver] ${sessionId} executing turn (engine: ${agent.engine}, model: ${agent.model})`);
  const argv = [backend.wrapperPath, ...turnBuild.argv];

  // Inject RESOURCES_DIR if the session has resources
  const freshSession = getSession(sessionId);
  if (freshSession?.resources && freshSession.resources.length > 0) {
    turnBuild.env.RESOURCES_DIR = "/tmp/resources";
  }

  // Inject vault entries as env vars (override server defaults)
  if (freshSession?.vault_ids && freshSession.vault_ids.length > 0) {
    for (const vaultId of freshSession.vault_ids) {
      const vaultEntries = listVaultEntries(vaultId);
      for (const entry of vaultEntries) {
        if (!BLOCKED_ENV_KEYS.has(entry.key)) {
          turnBuild.env[entry.key] = entry.value;
        }
      }
    }
  }

  // Compose the wrapper stdin: env KEY=value lines, blank line, prompt body.
  // Both backends' wrappers read env until blank line; from there claude
  // pipes stdin into `claude`, while opencode captures stdin into $PROMPT
  // and re-passes it as a trailing argv entry to `opencode`.
  const envLines = Object.entries(turnBuild.env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const stdin = `${envLines}\n\n${turnBuild.stdin}`;

  // Resolve the container provider and vault secrets for this session
  const env = getEnvironment(session.environment_id);
  const provider = await resolveContainerProvider(env?.config?.provider);
  const poolEntry = pool.getBySession(sessionId);
  // Pool entry may be missing after restart — fall back to resolving from vault_ids
  const secrets = poolEntry?.vaultSecrets
    ?? (session.vault_ids?.length
      ? (await import("../providers/resolve-secrets")).resolveVaultSecrets(session.vault_ids)
      : undefined);

  const tools = resolveToolset(agent.tools);
  // If threads are enabled, add spawn_agent to custom tool names so the
  // translator classifies it as a custom tool and emits custom_tool_use events.
  if (agent.threads_enabled) {
    tools.customToolNames.add("spawn_agent");
  }
  const translator = backend.createTranslator({
    customToolNames: tools.customToolNames,
    isFirstTurn: getSessionRow(sessionId)?.claude_session_id == null,
  });

  // Tool bridge: if this is a custom tool result re-entry on claude backend,
  // write response.json and remove the pending sentinel before --resume.
  if (agent.engine === "claude" && toolResults.length > 0) {
    const { TOOL_BRIDGE_RESPONSE_PATH, TOOL_BRIDGE_PENDING_PATH } = await import("../backends/claude/tool-bridge");
    const spriteName = getSessionRow(sessionId)?.sprite_name;
    if (spriteName) {
      for (const r of toolResults) {
        const responseJson = JSON.stringify({ content: r.content });
        await provider.exec(
          spriteName,
          ["bash", "-c", `cat > ${TOOL_BRIDGE_RESPONSE_PATH}`],
          { stdin: responseJson, secrets },
        ).catch((err: unknown) => {
          console.warn(`[driver] failed to write tool bridge response:`, err);
        });
        await provider.exec(
          spriteName,
          ["rm", "-f", TOOL_BRIDGE_PENDING_PATH],
          { secrets },
        ).catch(() => {});
      }
    }
  }

  const runtime = getRuntime();
  const controller = new AbortController();
  runtime.inFlightRuns.set(sessionId, {
    sessionId,
    controller,
    startedAt: turnStartMs,
  });

  let exec;
  try {
    exec = await provider.startExec(spriteName, {
      argv,
      stdin,
      signal: controller.signal,
      secrets,
    });
  } catch (err) {
    runtime.inFlightRuns.delete(sessionId);
    const msg = err instanceof Error ? err.message : String(err);
    appendEvent(sessionId, {
      type: "session.error",
      payload: { error: { type: "server_error", message: `exec failed: ${msg}` } },
      origin: "server",
      processedAt: nowMs(),
    });
    appendEvent(sessionId, {
      type: "session.status_idle",
      payload: { stop_reason: "error" },
      origin: "server",
      processedAt: nowMs(),
    });
    updateSessionStatus(sessionId, "idle", "error");
    return;
  }

  // Stream and translate
  // Strip sprites.dev HTTP exec framing bytes (0x00-0x1F) from the raw stream.
  // These are control chars used for stdout/stderr multiplexing in the HTTP
  // response body. JSON-escaped control chars (like `\u0001` in tool_result
  // payloads) are printable ASCII and are NOT affected by this strip.
  // Docker doesn't add these framing bytes, so stripping is conditional.
  const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
  let buffer = "";
  let aborted = false;
  let toolCallsInTurn = 0;

  // Permission confirmation: if the agent has confirmation_mode, start a
  // background poller that checks for /tmp/permission-bridge/pending every
  // 2 seconds during the stream loop. When found, it emits
  // agent.tool_confirmation_request and waits for the client to respond.
  let permissionPollTimer: ReturnType<typeof setInterval> | null = null;
  if (agent.confirmation_mode) {
    permissionPollTimer = setInterval(() => {
      void checkPermissionSentinel(sessionId, spriteName, provider).catch(
        (err: unknown) => {
          console.warn(`[driver] permission sentinel check failed:`, err);
        },
      );
    }, 2000);
  }

  try {
    const reader = exec.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const raw = decoder.decode(value, { stream: true });
      buffer += provider.stripControlChars ? raw.replace(CONTROL_CHARS, "") : raw;

      const batch: TranslatedEvent[] = [];
      buffer = parseNDJSONLines(buffer, (raw) => {
        const translated = translator.translate(raw);
        for (const t of translated) batch.push(t);
      });
      if (batch.length > 0) {
        const batchInputs = batch.map((t) => {
          if (t.type.endsWith("tool_use") || t.type.endsWith("mcp_tool_use") || t.type.endsWith("custom_tool_use")) {
            toolCallsInTurn++;
          }
          return {
            type: t.type,
            payload: t.payload,
            origin: "server" as const,
            processedAt: nowMs(),
          };
        });
        appendEventsBatch(sessionId, batchInputs);

        // Auto-generate session title from first agent.message text
        for (const t of batch) {
          if (t.type === "agent.message") {
            const row = getSessionRow(sessionId);
            if (row && row.title == null) {
              const content = t.payload.content as Array<{ type: string; text?: string }> | undefined;
              const text = content?.find((c) => c.type === "text" && c.text)?.text;
              if (text) {
                updateSessionMutable(sessionId, { title: text.slice(0, 60) });
              }
            }
            break; // only need the first agent.message
          }
        }
      }
    }
    await exec.exit;
  } catch (err) {
    if (controller.signal.aborted) {
      aborted = true;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      appendEvent(sessionId, {
        type: "session.error",
        payload: { error: { type: "server_error", message: msg } },
        origin: "server",
        processedAt: nowMs(),
      });
      appendEvent(sessionId, {
        type: "session.status_idle",
        payload: { stop_reason: "error" },
        origin: "server",
        processedAt: nowMs(),
      });
      updateSessionStatus(sessionId, "idle", "error");
      runtime.inFlightRuns.delete(sessionId);
      return;
    }
  } finally {
    if (permissionPollTimer) clearInterval(permissionPollTimer);
    runtime.inFlightRuns.delete(sessionId);
  }

  if (aborted) {
    appendEvent(sessionId, {
      type: "session.status_idle",
      payload: { stop_reason: "interrupted" },
      origin: "server",
      processedAt: nowMs(),
    });
    updateSessionStatus(sessionId, "idle", "interrupted");
    setIdleSince(sessionId, nowMs());
    scheduleDrain(sessionId);
    return;
  }

  // Finish turn: span end + status_idle + stats
  const result = translator.getTurnResult();
  const backendSid = translator.getBackendSessionId();
  if (backendSid) setBackendSessionId(sessionId, backendSid);

  const turnDurationSec = Math.max(0, (nowMs() - turnStartMs) / 1000);
  bumpSessionStats(
    sessionId,
    {
      turn_count: 1,
      tool_calls_count: toolCallsInTurn,
      duration_seconds: turnDurationSec,
      active_seconds: turnDurationSec,
    },
    result?.usage,
  );

  const now = nowMs();
  const stopReason = result?.stopReason ?? "end_turn";

  // Multi-agent threads: if stop_reason is custom_tool_call and the tool is
  // spawn_agent, intercept and delegate to the thread orchestrator. The result
  // is written back as a tool result and the turn is re-run automatically.
  if (stopReason === "custom_tool_call") {
    const serverToolResult = await handleServerSideTool(sessionId, agent);
    if (serverToolResult) {
      // spawn_agent was handled — the thread orchestrator already wrote the
      // result back. Re-run the turn with the tool result to continue.
      appendEvent(sessionId, {
        type: "span.model_request_end",
        payload: { model: agent.model, model_usage: result?.usage ?? null },
        origin: "server",
        processedAt: now,
      });
      appendEvent(sessionId, {
        type: "session.status_idle",
        payload: { stop_reason: "custom_tool_call" },
        origin: "server",
        processedAt: now,
      });
      updateSessionStatus(sessionId, "idle", "custom_tool_call");

      // Write the spawn result as response.json into the container
      const { TOOL_BRIDGE_RESPONSE_PATH, TOOL_BRIDGE_PENDING_PATH } = await import("../backends/claude/tool-bridge");
      const sprName = getSessionRow(sessionId)?.sprite_name;
      if (sprName) {
        const responseJson = JSON.stringify({ content: [{ type: "text", text: serverToolResult.text }] });
        const envForSession = getEnvironment(session.environment_id);
        const providerForReentry = await resolveContainerProvider(envForSession?.config?.provider);
        const reentrySecrets = pool.getBySession(sessionId)?.vaultSecrets;
        await providerForReentry.exec(
          sprName,
          ["bash", "-c", `cat > ${TOOL_BRIDGE_RESPONSE_PATH}`],
          { stdin: responseJson, secrets: reentrySecrets },
        ).catch((err: unknown) => {
          console.warn(`[driver] failed to write spawn_agent response:`, err);
        });
        await providerForReentry.exec(
          sprName,
          ["rm", "-f", TOOL_BRIDGE_PENDING_PATH],
          { secrets: reentrySecrets },
        ).catch(() => {});
      }

      // Re-run turn with tool result re-entry
      await runTurn(sessionId, [{
        kind: "tool_result",
        eventId: `server_tool_${nowMs()}`,
        custom_tool_use_id: serverToolResult.toolUseId,
        content: [{ type: "text", text: serverToolResult.text }],
      }], _depth + 1);
      return;
    }
  }

  appendEvent(sessionId, {
    type: "span.model_request_end",
    payload: {
      model: agent.model,
      model_usage: result?.usage ?? null,
    },
    origin: "server",
    processedAt: now,
  });

  appendEvent(sessionId, {
    type: "session.status_idle",
    payload: { stop_reason: stopReason },
    origin: "server",
    processedAt: now,
  });
  updateSessionStatus(sessionId, "idle", stopReason);
  console.log(`[driver] ${sessionId} turn complete: stop_reason=${stopReason}`);
  setIdleSince(sessionId, now);

  // Outcome evaluation: if the session has outcome criteria with a rubric,
  // run the grader loop. The grader calls the Anthropic API directly (not
  // claude -p on the container) to avoid corrupting session state.
  if (stopReason === "end_turn") {
    const criteria = getOutcomeCriteria(sessionId) as {
      description?: string;
      rubric?: string;
      max_iterations?: number;
      grader_iteration?: number;
    } | null;

    if (criteria?.rubric) {
      try {
        const { runGraderEvaluation } = await import("./grader");
        const maxIter = criteria.max_iterations ?? 3;
        const iteration = criteria.grader_iteration ?? 0;

        // Extract last agent.message text
        const recentEvents = listEvents(sessionId, { limit: 50, order: "desc" });
        let lastAgentText = "";
        for (const evt of recentEvents) {
          if (evt.type === "agent.message") {
            const payload = JSON.parse(evt.payload_json) as { content?: Array<{ type: string; text?: string }> };
            const text = (payload.content ?? [])
              .filter((b) => b.type === "text" && b.text)
              .map((b) => b.text!)
              .join("");
            if (text) { lastAgentText = text; break; }
          }
        }

        appendEvent(sessionId, {
          type: "span.outcome_evaluation_start",
          payload: { iteration },
          origin: "server",
          processedAt: nowMs(),
        });

        const evaluation = await runGraderEvaluation(
          criteria.rubric,
          lastAgentText,
          agent.model,
        );

        // Track grader token usage in session stats
        if (evaluation.usage.input_tokens || evaluation.usage.output_tokens) {
          bumpSessionStats(sessionId, {}, {
            input_tokens: evaluation.usage.input_tokens,
            output_tokens: evaluation.usage.output_tokens,
            cost_usd: 0,
          });
        }

        // Persist incremented iteration counter
        setOutcomeCriteria(sessionId, {
          ...criteria,
          grader_iteration: iteration + 1,
        });

        const finalResult = iteration + 1 >= maxIter && evaluation.result === "needs_revision"
          ? "max_iterations_reached"
          : evaluation.result;

        appendEvent(sessionId, {
          type: "span.outcome_evaluation_end",
          payload: {
            result: finalResult,
            iteration,
            feedback: evaluation.feedback,
          },
          origin: "server",
          processedAt: nowMs(),
        });

        // Re-run if needs_revision and under the iteration cap
        if (evaluation.result === "needs_revision" && iteration + 1 < maxIter) {
          await runTurn(sessionId, [{
            kind: "text",
            eventId: `grader_feedback_${nowMs()}`,
            text: `[Grader feedback — iteration ${iteration + 1}/${maxIter}]\n\n${evaluation.feedback}`,
          }], _depth + 1);
          return; // recursive runTurn handles the rest
        }
      } catch (err) {
        console.warn(`[driver] outcome evaluation failed for ${sessionId}:`, err);
      }
    }
  }

  scheduleDrain(sessionId);
}

/**
 * General server-side tool dispatcher. Checks the most recent
 * `agent.custom_tool_use` event and delegates to the matching handler:
 *   - `spawn_agent` → thread orchestrator
 *   - `memory_*`    → memory tool handler (Phase 3)
 *
 * Returns null if the tool call is not a server-side tool.
 */
export interface ServerToolResult {
  toolUseId: string;
  text: string;
}

async function handleServerSideTool(
  sessionId: string,
  agent: Agent,
): Promise<ServerToolResult | null> {
  // Look at recent events to find the last custom_tool_use
  const recentEvents = listEvents(sessionId, { limit: 20, order: "desc" });
  for (const evt of recentEvents) {
    if (evt.type === "agent.custom_tool_use") {
      const payload = JSON.parse(evt.payload_json) as {
        name?: string;
        tool_use_id?: string;
        input?: Record<string, unknown>;
      };
      const toolName = payload.name;
      const toolUseId = payload.tool_use_id ?? evt.id;

      // ── spawn_agent ──
      if (toolName === "spawn_agent" && agent.threads_enabled) {
        const input = payload.input as { agent_id?: string; prompt?: string } | undefined;
        if (input?.agent_id && input?.prompt) {
          // Validate callable_agents: if the agent has a callable_agents list,
          // the spawned agent must be in it.
          if (agent.callable_agents.length > 0) {
            const allowed = agent.callable_agents.some((ca) => ca.id === input.agent_id);
            if (!allowed) {
              return { toolUseId, text: `Error: agent ${input.agent_id} is not in callable_agents list` };
            }
          }
          const { handleSpawnAgent } = await import("./threads");
          const sessionRow = getSessionRow(sessionId);
          const depth = sessionRow?.thread_depth ?? 0;
          try {
            const text = await handleSpawnAgent(
              sessionId,
              input.agent_id,
              input.prompt,
              depth,
            );
            return { toolUseId, text };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { toolUseId, text: `Error: ${msg}` };
          }
        }
      }

      // ── memory_* tools (Phase 3 — placeholder) ──
      // if (toolName?.startsWith("memory_")) { ... }

      break; // Only check the most recent custom_tool_use
    }
  }
  return null;
}

/**
 * If any user.messages landed while a turn was running, launch another
 * runTurn to process them. Runs OUTSIDE the actor so it doesn't block
 * subsequent event POSTs. Concurrent turns for the same session are
 * prevented by the status flag.
 */
function scheduleDrain(sessionId: string): void {
  const pending = drainPendingUserInputs(sessionId);
  if (pending.length === 0) return;
  // Fire-and-forget — the next turn runs on its own, and the status flag
  // (flipped to "running" by runTurn's first step) prevents concurrent turns.
  void runTurn(sessionId, pending).catch((err: unknown) => {
    console.error(`[driver] scheduleDrain runTurn failed:`, err);
  });
}

// ---------------------------------------------------------------------------
// Permission confirmation support
// ---------------------------------------------------------------------------

/**
 * A set of session IDs that already have a pending confirmation request
 * emitted. Prevents duplicate events when the poller fires multiple times
 * before the hook clears the sentinel.
 *
 * Stored on globalThis so the set survives HMR reloads during development.
 */
type GlobalDriverState = typeof globalThis & { __caPendingConfirmations?: Set<string> };
const gd = globalThis as GlobalDriverState;
function getPendingConfirmations(): Set<string> {
  if (!gd.__caPendingConfirmations) gd.__caPendingConfirmations = new Set();
  return gd.__caPendingConfirmations;
}

/**
 * Background poller: checks if /tmp/permission-bridge/pending exists on
 * the container. When found, reads request.json, emits
 * `agent.tool_confirmation_request` on the event bus. The hook is still
 * blocked waiting for response.json — the events route will write that
 * when the client sends `user.tool_confirmation`.
 */
async function checkPermissionSentinel(
  sessionId: string,
  spriteName: string,
  provider: ContainerProvider,
): Promise<void> {
  if (getPendingConfirmations().has(sessionId)) return;

  try {
    const result = await provider.exec(
      spriteName,
      ["test", "-f", PERMISSION_BRIDGE_PENDING_PATH],
    );
    if (result.exit_code !== 0) return; // No pending sentinel
  } catch {
    return; // Container exec failed — not fatal
  }

  // Sentinel exists — read the request
  let request: { tool_name?: string; tool_input?: unknown; tool_use_id?: string };
  try {
    const result = await provider.exec(
      spriteName,
      ["cat", PERMISSION_BRIDGE_REQUEST_PATH],
    );
    request = JSON.parse(result.stdout) as typeof request;
  } catch (err) {
    console.warn(`[driver] failed to read permission request for ${sessionId}:`, err);
    return;
  }

  // Mark as pending to avoid duplicate events
  getPendingConfirmations().add(sessionId);

  // Emit the confirmation request event
  appendEvent(sessionId, {
    type: "agent.tool_confirmation_request",
    payload: {
      tool_name: request.tool_name ?? "unknown",
      tool_input: request.tool_input ?? {},
      tool_use_id: request.tool_use_id ?? "",
    },
    origin: "server",
    processedAt: nowMs(),
  });
}

/**
 * Write response.json into the container to unblock the permission hook.
 * Called from the events route when a `user.tool_confirmation` event is
 * received.
 */
export async function writePermissionResponse(
  sessionId: string,
  result: "allow" | "deny",
  denyMessage?: string,
): Promise<void> {
  const row = getSessionRow(sessionId);
  if (!row?.sprite_name) {
    console.warn(`[driver] no sprite for session ${sessionId}, cannot write permission response`);
    return;
  }

  const env = getEnvironment(row.environment_id);
  const provider = await resolveContainerProvider(env?.config?.provider);
  const permSecrets = pool.getBySession(sessionId)?.vaultSecrets;

  const response = JSON.stringify({
    result,
    deny_message: denyMessage ?? undefined,
  });

  try {
    await provider.exec(
      row.sprite_name,
      ["bash", "-c", `cat > ${PERMISSION_BRIDGE_RESPONSE_PATH}`],
      { stdin: response, secrets: permSecrets },
    );
  } catch (err) {
    console.warn(`[driver] failed to write permission response for ${sessionId}:`, err);
  }

  // Clear the pending flag so the poller can pick up future requests
  getPendingConfirmations().delete(sessionId);
}
