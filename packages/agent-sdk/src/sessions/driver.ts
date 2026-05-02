/**
 * Turn driver — orchestrates one turn of a backend CLI against a sandbox.
 *
 * Backend-agnostic: resolves the agent's `backend` field via the registry
 * and delegates argv/env/stdin construction + stream translation to the
 * concrete backend (claude, opencode, ...). The driver owns sandbox
 * acquisition, the stream loop, event bus appends, and usage persistence.
 *
 * Flow:
 *   1. Validate runtime config for the backend (fail fast before sandbox).
 *   2. Lazy-acquire the sandbox if the session has none yet.
 *   3. Mark each pending user.message as processed (processed_at = now).
 *   4. Flip session status to "running", append `session.status_running`
 *      and `span.model_request_start`.
 *   5. Call backend.buildTurn → argv + env + stdin. Compose the wrapper
 *      stdin body as `envLines \n\n stdin`.
 *   6. Spawn exec on the sandbox.
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
import { newTrace, childSpan, type TraceContext } from "./trace";
import type { AppendInput } from "../db/events";
import { getRuntime, drainPendingUserInputs, type TurnInput } from "../state";
import { getSession, setBackendSessionId, updateSessionStatus, updateSessionMutable, bumpSessionStats, setIdleSince, getSessionRow, getOutcomeCriteria, setOutcomeCriteria } from "../db/sessions";
import { getAgent } from "../db/agents";
import { getEnvironment } from "../db/environments";
import { getConfig } from "../config";
import { markUserEventProcessed, listEvents } from "../db/events";
import { acquireForFirstTurn, installSkills, provisionResources, wrapProviderWithSecrets } from "../containers/lifecycle";
import * as pool from "../containers/pool";
import { resolveBackend } from "../backends/registry";
import { resolveContainerProvider } from "../providers/registry";
import { BLOCKED_ENV_KEYS, resolveVaultSecrets } from "../providers/resolve-secrets";
import { loadSessionSecrets } from "./secrets";
import { parseNDJSONLines } from "../backends/shared/ndjson";
import type { TranslatedEvent } from "../backends/shared/translator-types";
import { classifyError, buildErrorPayload } from "./errors";
import { shouldRetry, incrementRetry, resetRetry, retryDelay } from "./retry";
import type { Agent } from "../types";
import type { ContainerProvider } from "../providers/types";
import { resolveToolset } from "./tools";
import { isProxied } from "../db/proxy";
import { ApiError } from "../errors";
import { nowMs } from "../util/clock";
import { injectMcpAuthHeaders } from "./mcp-auth";
import {
  PERMISSION_BRIDGE_PENDING_PATH,
  PERMISSION_BRIDGE_REQUEST_PATH,
  PERMISSION_BRIDGE_RESPONSE_PATH,
} from "../backends/claude/permission-hook";
import {
  TOOL_BRIDGE_PENDING_PATH,
  TOOL_BRIDGE_REQUEST_PATH,
  TOOL_BRIDGE_RESPONSE_PATH,
} from "../backends/claude/tool-bridge";

/**
 * Format stop_reason as an object for API responses.
 * DB columns continue to store the plain string; only event payloads use the object shape.
 */
function formatStopReason(reason: string, eventIds?: string[]): Record<string, unknown> {
  if (reason === "custom_tool_call") {
    return { type: "requires_action", event_ids: eventIds ?? [] };
  }
  return { type: reason };
}

export async function runTurn(
  sessionId: string,
  inputs: TurnInput[],
  _depth = 0,
  parentTrace?: TraceContext,
): Promise<void> {
  // Resolve trace context up front so even the early-return error paths below
  // carry a trace id. If this is a top-level turn (no parent), mint a fresh
  // trace; otherwise nest under the parent's current span.
  const trace: TraceContext = parentTrace ? childSpan(parentTrace) : newTrace();

  /**
   * Append a single event with this turn's trace + span ids baked in.
   * Used for every driver-emitted event during the turn so the trace tree
   * can be reconstructed from a single indexed scan on `events.trace_id`.
   */
  const emit = (type: string, payload: Record<string, unknown>, opts: { at?: number; parentOverride?: string | null } = {}): void => {
    const input: AppendInput = {
      type,
      payload,
      origin: "server",
      processedAt: opts.at ?? nowMs(),
      traceId: trace.trace_id,
      spanId: trace.span_id,
      parentSpanId: opts.parentOverride !== undefined ? opts.parentOverride : trace.parent_span_id,
    };
    appendEvent(sessionId, input);
  };

  if (_depth > 25) {
    emit("session.error", { error: { type: "server_error", message: "max recursion depth exceeded" } });
    updateSessionStatus(sessionId, "idle", "error");
    return;
  }
  const session = getSession(sessionId);
  if (!session) return; // session was deleted between enqueue and run
  if (inputs.length === 0) return;

  const agent = getAgent(session.agent.id, session.agent.version);
  if (!agent) {
    emit("session.error", { error: { type: "server_error", message: "agent not found" } });
    emit("session.status_idle", { stop_reason: formatStopReason("error") });
    updateSessionStatus(sessionId, "idle", "error");
    return;
  }

  const backend = resolveBackend(agent.engine);

  // Load all vault entries + credentials once — reused for runtime validation
  // bypass, MCP auth header injection, and env var injection.
  const vaultEntries: Array<{ key: string; value: string }> = [];
  if (session.vault_ids && session.vault_ids.length > 0) {
    const secrets = loadSessionSecrets(session.vault_ids);
    vaultEntries.push(...secrets.map(s => ({ key: s.key, value: s.value })));
  }
  const hasVaultKeys = vaultEntries.length > 0;

  // Belt-and-braces runtime validation. Config may have changed since the
  // agent was created (env vars cleared, settings table mutated). Fail fast
  // BEFORE sandbox acquire / install so a 3-minute install isn't wasted on a
  // misconfigured backend.
  // Skip if session has vault entries — they provide keys at container level.
  if (!hasVaultKeys) {
    const runtimeErr = backend.validateRuntime?.();
    if (runtimeErr) {
      emit("session.error", { error: { type: "invalid_request_error", message: runtimeErr } });
      emit("session.status_idle", { stop_reason: formatStopReason("error") });
      updateSessionStatus(sessionId, "idle", "error");
      return;
    }
  }

  // Budget check: refuse turn if session OR owning key is over budget.
  // Session budget = max_budget_usd on the row (pre-0.4 field, unchanged).
  // Key budget = api_keys.budget_usd vs api_keys.spent_usd (v0.4 PR3).
  // Both raise session.error{type:"budget_exceeded"} with a scope tag.
  const budgetRow = getSessionRow(sessionId);
  if (budgetRow?.max_budget_usd != null && budgetRow.usage_cost_usd >= budgetRow.max_budget_usd) {
    emit("session.error", {
      error: {
        type: "budget_exceeded",
        scope: "session",
        message: `usage $${budgetRow.usage_cost_usd.toFixed(4)} >= session budget $${budgetRow.max_budget_usd.toFixed(4)}`,
      },
    });
    emit("session.status_idle", { stop_reason: formatStopReason("error") });
    updateSessionStatus(sessionId, "idle", "error");
    return;
  }
  if (budgetRow?.api_key_id) {
    const { getApiKeyById } = await import("../db/api_keys");
    const key = getApiKeyById(budgetRow.api_key_id);
    if (key && key.budget_usd != null && (key.spent_usd ?? 0) >= key.budget_usd) {
      emit("session.error", {
        error: {
          type: "budget_exceeded",
          scope: "key",
          message: `api key "${key.name}" spent $${(key.spent_usd ?? 0).toFixed(4)} >= budget $${key.budget_usd.toFixed(4)}`,
        },
      });
      emit("session.status_idle", { stop_reason: formatStopReason("error") });
      updateSessionStatus(sessionId, "idle", "error");
      return;
    }
  }

  // Token quota: refuse turn if session has consumed >= max_tokens
  if (budgetRow != null) {
    const totalTokens = (budgetRow.usage_input_tokens ?? 0) + (budgetRow.usage_output_tokens ?? 0);
    if (budgetRow.max_tokens != null && totalTokens >= budgetRow.max_tokens) {
      emit("session.error", {
        error: {
          type: "quota_exceeded",
          scope: "session",
          message: `tokens used ${totalTokens} >= session token limit ${budgetRow.max_tokens}`,
        },
      });
      emit("session.status_idle", { stop_reason: formatStopReason("error") });
      updateSessionStatus(sessionId, "idle", "error");
      return;
    }
  }

  // Wall-duration quota: refuse turn if session age >= max_wall_duration_ms
  if (budgetRow != null && budgetRow.max_wall_duration_ms != null) {
    const ageMs = nowMs() - budgetRow.created_at;
    if (ageMs >= budgetRow.max_wall_duration_ms) {
      emit("session.error", {
        error: {
          type: "quota_exceeded",
          scope: "session",
          message: `session age ${ageMs}ms >= wall limit ${budgetRow.max_wall_duration_ms}ms`,
        },
      });
      emit("session.status_idle", { stop_reason: formatStopReason("error") });
      updateSessionStatus(sessionId, "idle", "error");
      return;
    }
  }

  // Mark each pending input as processed-now
  for (const p of inputs) markUserEventProcessed(p.eventId, nowMs());

  // Auto-title from first user message if session has no title yet
  const row = getSessionRow(sessionId);
  if (row && row.title == null) {
    const firstText = inputs.find((i): i is Extract<TurnInput, { kind: "text" }> => i.kind === "text");
    if (firstText?.text) {
      // Strip control chars, "Image" prefix from pasted content, and collapse whitespace
      const sanitized = firstText.text
        .replace(/[\x00-\x1F\x7F\u200B-\u200F\u2028-\u202F\uFEFF]/g, "")
        .replace(/^Image(?=[A-Z])/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (sanitized) {
        updateSessionMutable(sessionId, { title: sanitized.slice(0, 60) });
      }
    }
  }

  // Acquire sandbox if needed
  console.log(`[driver] ${sessionId} acquiring container...`);
  let sandboxName: string;
  try {
    sandboxName = await acquireForFirstTurn(sessionId);
    console.log(`[driver] ${sessionId} container ready: ${sandboxName}`);

    // Resolve vault secrets once for any post-acquire provider work below.
    // Pool entry was populated by acquireForFirstTurn; fall back to vault_ids
    // for restart cases where the pool is empty until lazy re-population.
    // Without these, subsequent provider.exec calls fail "SPRITE_TOKEN required"
    // when the token only lives in the vault, not in process.env / settings.
    const postAcquireSecrets = pool.getBySession(sessionId)?.vaultSecrets
      ?? (session.vault_ids?.length ? resolveVaultSecrets(session.vault_ids) : undefined);

    // Re-inject skills if agent has been updated (new or changed skills)
    const latestAgent = getAgent(session.agent.id);
    if (latestAgent && latestAgent.skills && latestAgent.skills.length > 0) {
      const currentSkills = new Map((agent.skills ?? []).map(s => [s.name, s.content.length]));
      const newSkills = latestAgent.skills.filter(s =>
        !currentSkills.has(s.name) || currentSkills.get(s.name) !== s.content.length
      );
      if (newSkills.length > 0) {
        console.log(`[driver] ${sessionId} injecting ${newSkills.length} new skill(s)...`);
        const envRow = getEnvironment(session.environment_id);
        const baseProvider = await resolveContainerProvider(envRow?.config?.provider);
        const sp = wrapProviderWithSecrets(baseProvider, postAcquireSecrets);
        await installSkills(sandboxName, sp, newSkills, agent.engine);
        console.log(`[driver] ${sessionId} skills injected`);
      }
    }

    // Re-provision resources (files/repos added after container creation)
    const freshSession = getSession(sessionId);
    if (freshSession?.resources && freshSession.resources.length > 0) {
      const envRow = getEnvironment(session.environment_id);
      const baseProvider = await resolveContainerProvider(envRow?.config?.provider);
      const sp = wrapProviderWithSecrets(baseProvider, postAcquireSecrets);
      await provisionResources(sandboxName, freshSession.resources, sp);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit("session.error", { error: { type: "server_error", message: `container creation failed: ${msg}` } });
    emit("session.status_idle", { stop_reason: formatStopReason("error") });
    updateSessionStatus(sessionId, "idle", "error");
    return;
  }

  // Flip running + emit status_running + span start
  updateSessionStatus(sessionId, "running");
  const turnStartMs = nowMs();
  emit("session.status_running", {}, { at: turnStartMs });
  // The span_start event is the formal open of this turn's root span. After
  // this point every error path MUST emit a matching span_end (status=error
  // or status=interrupted) or the trace tree is left dangling.
  emit("span.model_request_start", { model: agent.model }, { at: turnStartMs });

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

  // Inject vault credentials as MCP server auth headers.
  // Convention: vault key "MCP_AUTH_{SERVER}" → Authorization: Bearer header
  //             vault key "MCP_HEADER_{SERVER}_{HEADER}" → custom header
  const agentForTurn = injectMcpAuthHeaders(agent, vaultEntries);

  let turnBuild;
  try {
    turnBuild = backend.buildTurn({
      agent: agentForTurn,
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
    // Close the open turn span before returning. Without this, the
    // span.model_request_start emitted above would leave a dangling open
    // span in the trace.
    emit("span.model_request_end", { model: agent.model, model_usage: null, status: "error" });
    emit("session.error", { error: { type, message: msg } });
    emit("session.status_idle", { stop_reason: formatStopReason("error") });
    updateSessionStatus(sessionId, "idle", "error");
    return;
  }

  // Codex bwrap conflicts with Firecracker: the inner bubblewrap sandbox
  // requires user namespaces that Firecracker VMs don't expose. The outer VM
  // already provides hardware-level isolation. Replace --full-auto with
  // --dangerously-bypass-approvals-and-sandbox (--yolo) which skips bwrap
  // entirely. The two flags conflict — can't use both. (openai/codex#15282)
  if (agent.engine === "codex") {
    const envRow = getEnvironment(session.environment_id);
    const provName = envRow?.config?.provider ?? "docker";
    const firecrackerProviders = new Set(["sprites", "fly", "apple-firecracker"]);
    if (firecrackerProviders.has(provName)) {
      // Remove --full-auto (conflicts with --yolo)
      const faIdx = turnBuild.argv.indexOf("--full-auto");
      if (faIdx >= 0) turnBuild.argv.splice(faIdx, 1);
      // Insert --yolo before the trailing `-` (stdin marker)
      const lastIdx = turnBuild.argv.lastIndexOf("-");
      if (lastIdx >= 0) {
        turnBuild.argv.splice(lastIdx, 0, "--dangerously-bypass-approvals-and-sandbox");
      } else {
        turnBuild.argv.push("--dangerously-bypass-approvals-and-sandbox");
      }
    }
  }

  console.log(`[driver] ${sessionId} executing turn (engine: ${agent.engine}, model: ${agent.model})`);
  const argv = [backend.wrapperPath, ...turnBuild.argv];

  // Inject RESOURCES_DIR if the session has resources
  const freshSession = getSession(sessionId);
  if (freshSession?.resources && freshSession.resources.length > 0) {
    turnBuild.env.RESOURCES_DIR = "/tmp/resources";
  }

  // Give agent-configured MCP servers more time to connect on Firecracker VMs
  // where Node.js cold-start takes ~1.2s. Default is 5s which is too tight.
  if (agent.engine === "claude" && !turnBuild.env.MCP_TIMEOUT) {
    turnBuild.env.MCP_TIMEOUT = "30000";
  }

  // Inject vault entries as env vars (override server defaults).
  // Skip MCP_AUTH_* and MCP_HEADER_* keys — they were already consumed
  // as MCP server headers and should not leak into the container env.
  const MCP_KEY_RE = /^MCP_(AUTH|HEADER)_/i;
  for (const entry of vaultEntries) {
    if (!BLOCKED_ENV_KEYS.has(entry.key) && !MCP_KEY_RE.test(entry.key)) {
      turnBuild.env[entry.key] = entry.value;
    }
  }
  // If vault provides OPENAI_API_KEY, also set CODEX_API_KEY so the codex
  // backend picks it up (codex checks CODEX_API_KEY before OPENAI_API_KEY).
  if (turnBuild.env.OPENAI_API_KEY && !turnBuild.env.CODEX_API_KEY) {
    turnBuild.env.CODEX_API_KEY = turnBuild.env.OPENAI_API_KEY;
  }
  // Auto-remap: if ANTHROPIC_API_KEY is an OAuth token (sk-ant-oat*),
  // move it to CLAUDE_CODE_OAUTH_TOKEN. Claude CLI doesn't recognize
  // OAuth tokens in ANTHROPIC_API_KEY — it expects them in a separate
  // env var. Without this, the CLI garbles stdin parsing (Bug #2/#5).
  if (turnBuild.env.ANTHROPIC_API_KEY?.startsWith("sk-ant-oat")) {
    turnBuild.env.CLAUDE_CODE_OAUTH_TOKEN = turnBuild.env.ANTHROPIC_API_KEY;
    delete turnBuild.env.ANTHROPIC_API_KEY;
  }
  // If vault provides CLAUDE_CODE_OAUTH_TOKEN, remove ANTHROPIC_API_KEY
  // so Claude Code uses the OAuth token (it prefers ANTHROPIC_API_KEY when both set)
  if (turnBuild.env.CLAUDE_CODE_OAUTH_TOKEN && turnBuild.env.ANTHROPIC_API_KEY) {
    delete turnBuild.env.ANTHROPIC_API_KEY;
  }
  // Ollama: inject env vars so backend CLIs can reach the host's Ollama
  // server from inside the container.
  // - OLLAMA_HOST: used by the ollama CLI itself (host:port, no scheme)
  // - CODEX_OSS_BASE_URL: used by Codex --local-provider ollama (http://host:port/v1)
  // - OPENCODE_CONFIG_CONTENT: patched with the correct baseURL for opencode
  const ollamaCloudPrefixes = ["claude-", "gpt-", "o1-", "o3-", "o4-", "codex-", "chatgpt-", "gemini-"];
  const isOllamaModel = !agent.model.includes("/") && !ollamaCloudPrefixes.some(p => agent.model.startsWith(p));
  if (isOllamaModel) {
    let ollamaHostPort: string | undefined;
    if (!turnBuild.env.OLLAMA_HOST) {
      const envRow = getEnvironment(session.environment_id);
      const provName = envRow?.config?.provider ?? "docker";
      if (provName === "docker" || provName === "podman") {
        ollamaHostPort = "host.docker.internal:11434";
      } else if (provName === "apple-container" || provName === "apple-firecracker") {
        // Apple Containers run in VMs — localhost inside the VM doesn't reach the host.
        // Ollama must be started with OLLAMA_HOST=0.0.0.0:11434 to listen on all interfaces.
        // The container reaches the host via its gateway IP (192.168.64.1 by default).
        const customUrl = getConfig().ollamaUrl;
        ollamaHostPort = customUrl !== "http://localhost:11434"
          ? customUrl.replace(/^https?:\/\//, "")
          : "192.168.64.1:11434";
      }
      if (ollamaHostPort) {
        turnBuild.env.OLLAMA_HOST = ollamaHostPort;
      }
    } else {
      ollamaHostPort = turnBuild.env.OLLAMA_HOST;
    }
    // Codex reads CODEX_OSS_BASE_URL (not OLLAMA_HOST) for its --local-provider ollama
    if (ollamaHostPort && !turnBuild.env.CODEX_OSS_BASE_URL) {
      const host = ollamaHostPort.replace(/^https?:\/\//, "");
      turnBuild.env.CODEX_OSS_BASE_URL = `http://${host}/v1`;
    }
    // Patch OpenCode's OPENCODE_CONFIG_CONTENT with the correct Ollama baseURL
    if (ollamaHostPort && turnBuild.env.OPENCODE_CONFIG_CONTENT) {
      try {
        const cfg = JSON.parse(turnBuild.env.OPENCODE_CONFIG_CONTENT);
        const host = ollamaHostPort.replace(/^https?:\/\//, "");
        if (cfg.provider?.ollama?.options) {
          cfg.provider.ollama.options.baseURL = `http://${host}/v1`;
          turnBuild.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(cfg);
        }
      } catch { /* leave config as-is if parse fails */ }
    }
    // Codex needs a dummy OPENAI_API_KEY to not error on startup
    if (!turnBuild.env.OPENAI_API_KEY) {
      turnBuild.env.OPENAI_API_KEY = "ollama";
    }
    if (!turnBuild.env.CODEX_API_KEY) {
      turnBuild.env.CODEX_API_KEY = "ollama";
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
    ?? (session.vault_ids?.length ? resolveVaultSecrets(session.vault_ids) : undefined);

  const tools = resolveToolset(agent.tools);
  // If threads are enabled, add spawn_agent to custom tool names so the
  // translator classifies it as a custom tool and emits custom_tool_use events.
  if (agent.threads_enabled) {
    tools.customToolNames.add("spawn_agent");
  }
  const translator = backend.createTranslator({
    customToolNames: tools.customToolNames,
    isFirstTurn: getSessionRow(sessionId)?.claude_session_id == null,
    // Observability: allow the translator to mint per-tool child spans
    // nested under the turn's root span. Translators that don't implement
    // this simply ignore the option.
    turnSpanId: trace.span_id,
  });

  // Tool bridge: if this is a custom tool result re-entry on claude backend,
  // write response.json and remove the pending sentinel before --resume.
  if (agent.engine === "claude" && toolResults.length > 0) {
    const { TOOL_BRIDGE_RESPONSE_PATH, TOOL_BRIDGE_PENDING_PATH } = await import("../backends/claude/tool-bridge");
    const sandboxName = getSessionRow(sessionId)?.sandbox_name;
    if (sandboxName) {
      for (const r of toolResults) {
        const responseJson = JSON.stringify({ content: r.content });
        await provider.exec(
          sandboxName,
          ["sh", "-c", `cat > ${TOOL_BRIDGE_RESPONSE_PATH}`],
          { stdin: responseJson, secrets },
        ).catch((err: unknown) => {
          console.warn(`[driver] failed to write tool bridge response:`, err);
        });
        await provider.exec(
          sandboxName,
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
    exec = await provider.startExec(sandboxName, {
      argv,
      stdin,
      signal: controller.signal,
      secrets,
    });
  } catch (err) {
    runtime.inFlightRuns.delete(sessionId);
    const msg = err instanceof Error ? err.message : String(err);
    // Close the open turn span before returning — see buildTurn catch above.
    emit("span.model_request_end", { model: agent.model, model_usage: null, status: "error" });
    emit("session.error", { error: { type: "server_error", message: `exec failed: ${msg}` } });
    emit("session.status_idle", { stop_reason: formatStopReason("error") });
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
      void checkPermissionSentinel(sessionId, sandboxName, provider).catch(
        (err: unknown) => {
          console.warn(`[driver] permission sentinel check failed:`, err);
        },
      );
    }, 2000);
  }

  // Custom tool bridge: poll for /tmp/tool-bridge/pending during the stream
  // loop. When found, read request.json, emit agent.custom_tool_use, and wait
  // for the client to respond with user.custom_tool_result (which calls
  // writeToolBridgeResponse to unblock the bridge inside the container).
  let toolBridgePollTimer: ReturnType<typeof setInterval> | null = null;
  if (agent.engine === "claude" && tools.customToolNames.size > 0) {
    toolBridgePollTimer = setInterval(() => {
      void checkToolBridgeSentinel(sessionId, sandboxName, provider, secrets, trace).catch(
        (err: unknown) => {
          console.warn(`[driver] tool bridge sentinel check failed:`, err);
        },
      );
    }, 1000);
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
        if (process.env.DEBUG_NDJSON) console.log("[ndjson]", JSON.stringify(raw));
        const translated = translator.translate(raw);
        for (const t of translated) batch.push(t);
      });
      if (batch.length > 0) {
        const batchInputs: AppendInput[] = batch.map((t) => {
          if (t.type.endsWith("tool_use") || t.type.endsWith("mcp_tool_use") || t.type.endsWith("custom_tool_use")) {
            toolCallsInTurn++;
          }
          // Translator-emitted per-tool spans override the turn's default
          // span context: `span.tool_call_start` gets its own fresh span
          // id whose parent is the turn span, `agent.tool_use` rides
          // under that same tool span id, etc.
          const spanId = t.spanId ?? trace.span_id;
          const parentSpanId = t.parentSpanId ?? trace.parent_span_id;
          return {
            type: t.type,
            payload: t.payload,
            origin: "server" as const,
            processedAt: nowMs(),
            traceId: trace.trace_id,
            spanId,
            parentSpanId,
          };
        });
        appendEventsBatch(sessionId, batchInputs);
      }
    }
    // Flush any trailing NDJSON line left in the buffer (CLI may not
    // terminate its last line with \n, leaving it as a remainder that
    // parseNDJSONLines never processes).
    if (buffer.trim()) {
      try {
        const trailing = JSON.parse(buffer.trim()) as Record<string, unknown>;
        if (process.env.DEBUG_NDJSON) console.log("[ndjson] flush-trailing", JSON.stringify(trailing));
        const translated = translator.translate(trailing);
        if (translated.length > 0) {
          const batchInputs: AppendInput[] = translated.map((t) => ({
            type: t.type,
            payload: t.payload,
            origin: "server" as const,
            processedAt: nowMs(),
            traceId: trace.trace_id,
            spanId: t.spanId ?? trace.span_id,
            parentSpanId: t.parentSpanId ?? trace.parent_span_id,
          }));
          appendEventsBatch(sessionId, batchInputs);
        }
      } catch { /* not valid JSON — ignore */ }
      buffer = "";
    }

    const exitResult = await exec.exit;
    if (process.env.DEBUG_NDJSON && exitResult) {
      console.log(`[driver] ${sessionId} exit code: ${(exitResult as { code?: number }).code}`);
    }
    // If the process exited with non-zero and the translator received no
    // meaningful output, surface an error. We check toolCallsInTurn as a
    // proxy for "translator saw events" — if the CLI responded then crashed
    // (exit code 2), the response is already committed and an error event
    // would be confusing (Bug #3).
    const exitCode = (exitResult as { code?: number })?.code;
    const translatorSawOutput = toolCallsInTurn > 0 || translator.getTurnResult()?.stopReason != null;
    if (exitCode !== 0 && !translatorSawOutput) {
      const code = exitCode ?? "unknown";
      emit("session.error", {
        error: {
          type: "backend_error",
          message: `Backend CLI exited with code ${code} and no output. Check that the engine is installed and the API key is valid.`,
        },
      });
    }
  } catch (err) {
    if (controller.signal.aborted) {
      aborted = true;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      const classified = classifyError(msg);
      const retry = shouldRetry(sessionId, classified);

      if (retry) {
        // Auto-retry: emit rescheduled event (with trace context), wait, then re-run
        incrementRetry(sessionId);
        emit("session.error", { error: { type: "server_error", message: msg, classified } });
        emit("session.status_rescheduled", { retry_attempt: retry.attempt, retry_delay_ms: retry.delayMs });
        runtime.inFlightRuns.delete(sessionId);
        await retryDelay(retry.delayMs);
        // Re-run the turn (recursive call with original inputs + incremented depth)
        return runTurn(sessionId, inputs, _depth + 1, parentTrace);
      }

      // Not retryable or exhausted — close the open turn span before returning.
      // This path is reached when the NDJSON stream itself fails (translator
      // throw, read error, or exhausted retries).
      emit("span.model_request_end", { model: agent.model, model_usage: null, status: "error" });
      const retryStatus = classified.retryable ? "exhausted" : "terminal";
      emit("session.error", { error: buildErrorPayload(classified, retryStatus) });
      emit("session.status_idle", { stop_reason: formatStopReason("error") });
      updateSessionStatus(sessionId, "idle", "error");
      runtime.inFlightRuns.delete(sessionId);
      return;
    }
  } finally {
    if (permissionPollTimer) clearInterval(permissionPollTimer);
    if (toolBridgePollTimer) clearInterval(toolBridgePollTimer);
    getPendingToolBridgeCalls().delete(sessionId);
    runtime.inFlightRuns.delete(sessionId);
  }

  if (aborted) {
    // Close the open turn span on the interrupt path so the trace tree
    // doesn't hang forever waiting for an end boundary.
    const partial = translator.getTurnResult();
    emit("span.model_request_end", {
      model: agent.model,
      model_usage: partial?.usage ?? null,
      status: "interrupted",
    });
    emit("session.status_idle", { stop_reason: formatStopReason("interrupted") });
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

  // Container file sync: extract modified files before going idle.
  // Must run before status_idle so the container is still alive.
  const sessionRowForSync = getSessionRow(sessionId);
  if (sessionRowForSync?.sandbox_name && !isProxied(sessionId)) {
    try {
      const { syncContainerFiles } = await import("../sync/container-file-sync");
      const syncResult = await syncContainerFiles({
        sessionId,
        sandboxName: sessionRowForSync.sandbox_name,
        provider,
        secrets,
      });
      if (syncResult.synced > 0) {
        console.log(`[driver] synced ${syncResult.synced} files from container (${syncResult.skipped} skipped)`);
      }
    } catch (err) {
      console.warn("[driver] container file sync failed:", (err as Error)?.stack ?? err);
    }
  }

  const now = nowMs();
  const stopReason = result?.stopReason ?? "end_turn";

  // Multi-agent threads: if stop_reason is custom_tool_call and the tool is
  // spawn_agent, intercept and delegate to the thread orchestrator. The result
  // is written back as a tool result and the turn is re-run automatically.
  if (stopReason === "custom_tool_call") {
    // Collect event IDs of pending custom tool use events for the stop_reason payload
    const customToolEventIds = listEvents(sessionId, { limit: 20, order: "desc" })
      .filter(e => e.type === "agent.custom_tool_use")
      .map(e => e.id);

    const serverToolResult = await handleServerSideTool(sessionId, agent, trace);
    if (serverToolResult) {
      // spawn_agent was handled — the thread orchestrator already wrote the
      // result back. Re-run the turn with the tool result to continue.
      emit(
        "span.model_request_end",
        { model: agent.model, model_usage: result?.usage ?? null, status: "ok" },
        { at: now },
      );
      emit("session.status_idle", { stop_reason: formatStopReason("custom_tool_call", customToolEventIds) }, { at: now });
      updateSessionStatus(sessionId, "idle", "custom_tool_call");

      // Write the spawn result as response.json into the container
      const { TOOL_BRIDGE_RESPONSE_PATH, TOOL_BRIDGE_PENDING_PATH } = await import("../backends/claude/tool-bridge");
      const sprName = getSessionRow(sessionId)?.sandbox_name;
      if (sprName) {
        const responseJson = JSON.stringify({ content: [{ type: "text", text: serverToolResult.text }] });
        const envForSession = getEnvironment(session.environment_id);
        const providerForReentry = await resolveContainerProvider(envForSession?.config?.provider);
        const reentrySecrets = pool.getBySession(sessionId)?.vaultSecrets;
        await providerForReentry.exec(
          sprName,
          ["sh", "-c", `cat > ${TOOL_BRIDGE_RESPONSE_PATH}`],
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

      // Re-run turn with tool result re-entry. Pass `trace` as the parent
      // so the recursion's span is nested under this turn — the whole
      // custom-tool loop renders as a single trace tree.
      await runTurn(sessionId, [{
        kind: "tool_result",
        eventId: `server_tool_${nowMs()}`,
        custom_tool_use_id: serverToolResult.toolUseId,
        content: [{ type: "text", text: serverToolResult.text }],
      }], _depth + 1, trace);
      return;
    }
  }

  emit(
    "span.model_request_end",
    { model: agent.model, model_usage: result?.usage ?? null, status: "ok" },
    { at: now },
  );
  // For custom_tool_call that wasn't handled server-side, collect event IDs for the stop_reason
  const finalEventIds = stopReason === "custom_tool_call"
    ? listEvents(sessionId, { limit: 20, order: "desc" })
        .filter(e => e.type === "agent.custom_tool_use")
        .map(e => e.id)
    : undefined;
  emit("session.status_idle", { stop_reason: formatStopReason(stopReason, finalEventIds) }, { at: now });
  updateSessionStatus(sessionId, "idle", stopReason);
  resetRetry(sessionId); // Clear retry counter on successful completion
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

        emit("span.outcome_evaluation_start", { iteration });

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

        emit("span.outcome_evaluation_end", {
          result: finalResult,
          iteration,
          feedback: evaluation.feedback,
        });

        // Re-run if needs_revision and under the iteration cap. Pass
        // `trace` so the grader-feedback recursion nests under this turn
        // and the full evaluator loop renders as one trace tree.
        if (evaluation.result === "needs_revision" && iteration + 1 < maxIter) {
          await runTurn(sessionId, [{
            kind: "text",
            eventId: `grader_feedback_${nowMs()}`,
            text: `[Grader feedback — iteration ${iteration + 1}/${maxIter}]\n\n${evaluation.feedback}`,
          }], _depth + 1, trace);
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
  parentTrace: TraceContext,
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
              parentTrace,
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
  sandboxName: string,
  provider: ContainerProvider,
): Promise<void> {
  if (getPendingConfirmations().has(sessionId)) return;

  try {
    const result = await provider.exec(
      sandboxName,
      ["test", "-f", PERMISSION_BRIDGE_PENDING_PATH],
      { timeoutMs: 5000 },
    );
    if (result.exit_code !== 0) return; // No pending sentinel
  } catch {
    return; // Container exec failed — not fatal
  }

  // Sentinel exists — read the request
  let request: { tool_name?: string; tool_input?: unknown; tool_use_id?: string };
  try {
    const result = await provider.exec(
      sandboxName,
      ["cat", PERMISSION_BRIDGE_REQUEST_PATH],
      { timeoutMs: 5000 },
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
  if (!row?.sandbox_name) {
    console.warn(`[driver] no sandbox for session ${sessionId}, cannot write permission response`);
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
      row.sandbox_name,
      ["sh", "-c", `cat > ${PERMISSION_BRIDGE_RESPONSE_PATH}`],
      { stdin: response, secrets: permSecrets },
    );
  } catch (err) {
    console.warn(`[driver] failed to write permission response for ${sessionId}:`, err);
  }

  // Clear the pending flag so the poller can pick up future requests
  getPendingConfirmations().delete(sessionId);
}

// ---------------------------------------------------------------------------
// Custom tool bridge sentinel poller
// ---------------------------------------------------------------------------

/** Sessions with an in-flight tool bridge call (prevents duplicate events). */
const pendingToolBridgeCalls = new Set<string>();
export function getPendingToolBridgeCalls(): Set<string> {
  return pendingToolBridgeCalls;
}

/**
 * Check for /tmp/tool-bridge/pending inside the container. If found, read
 * request.json, emit agent.custom_tool_use, and wait for the client to
 * send user.custom_tool_result (which triggers writeToolBridgeResponse).
 *
 * Mirrors the checkPermissionSentinel pattern — runs on a 1s interval
 * during the stream loop so the MCP bridge inside the container isn't
 * blocked waiting for response.json that nobody writes.
 */
async function checkToolBridgeSentinel(
  sessionId: string,
  sandboxName: string,
  provider: ContainerProvider,
  secrets: Record<string, string> | undefined,
  trace: TraceContext,
): Promise<void> {
  if (pendingToolBridgeCalls.has(sessionId)) return;

  try {
    const result = await provider.exec(
      sandboxName,
      ["test", "-f", TOOL_BRIDGE_PENDING_PATH],
      { secrets, timeoutMs: 5000 },
    );
    if (result.exit_code !== 0) return; // No pending sentinel
  } catch {
    return;
  }

  // Sentinel exists — read the request
  let request: { tool_use_id?: string; name?: string; input?: unknown };
  try {
    const result = await provider.exec(
      sandboxName,
      ["cat", TOOL_BRIDGE_REQUEST_PATH],
      { secrets, timeoutMs: 5000 },
    );
    // Strip sprites HTTP exec control chars (stdout/stderr multiplexing)
    const clean = result.stdout.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    request = JSON.parse(clean) as typeof request;
  } catch (err) {
    console.warn(`[driver] failed to read tool bridge request for ${sessionId}:`, err);
    return;
  }

  // Guard: if save_output is called with a script file (.js, .py, .sh, .ts),
  // auto-respond with an error telling the agent to run the script first.
  // This prevents the model from short-circuiting (Write → save_output)
  // when it should be (Write → Bash run → save_output with result).
  const input = request.input as Record<string, unknown> | undefined;
  const filename = (input?.filename as string) ?? "";
  const SCRIPT_EXTS = /\.(js|ts|py|sh|mjs|cjs)$/i;
  if (request.name === "save_output" && SCRIPT_EXTS.test(filename)) {
    console.log(`[driver] ${sessionId} rejecting save_output for script file: ${filename}`);
    pendingToolBridgeCalls.add(sessionId);
    await writeToolBridgeResponse(sessionId, [{
      type: "text",
      text: `Error: "${filename}" is a script file, not a deliverable. Run the script first (e.g. "node ${filename}" or "python3 ${filename}"), then call save_output with the OUTPUT file (e.g. the .docx, .pdf, or .csv that the script produces).`,
    }]);
    return;
  }

  // Mark as pending to avoid duplicate events
  pendingToolBridgeCalls.add(sessionId);

  console.log(`[driver] ${sessionId} custom tool call: ${request.name} (${request.tool_use_id})`);

  // Emit agent.custom_tool_use so the client sees it on the SSE stream
  appendEvent(sessionId, {
    type: "agent.custom_tool_use",
    payload: {
      tool_use_id: request.tool_use_id ?? "",
      name: request.name ?? "unknown",
      input: request.input ?? {},
    },
    origin: "server",
    processedAt: nowMs(),
    traceId: trace.trace_id,
    spanId: trace.span_id,
    parentSpanId: trace.parent_span_id,
  });
}

/**
 * Write response.json into the container to unblock the tool bridge MCP
 * server. Called from the events route when a `user.custom_tool_result`
 * event is received while the session is running (tool bridge is blocking).
 */
export async function writeToolBridgeResponse(
  sessionId: string,
  content: unknown[],
): Promise<void> {
  const row = getSessionRow(sessionId);
  if (!row?.sandbox_name) {
    console.warn(`[driver] no sandbox for session ${sessionId}, cannot write tool bridge response`);
    return;
  }

  const env = getEnvironment(row.environment_id);
  const provider = await resolveContainerProvider(env?.config?.provider);
  const bridgeSecrets = pool.getBySession(sessionId)?.vaultSecrets;

  // The bridge expects {content: [...]} with text blocks
  const response = JSON.stringify({ content });

  try {
    await provider.exec(
      row.sandbox_name,
      ["sh", "-c", `cat > ${TOOL_BRIDGE_RESPONSE_PATH}`],
      { stdin: response, secrets: bridgeSecrets },
    );
    // Remove the pending sentinel so the bridge doesn't re-trigger
    await provider.exec(
      row.sandbox_name,
      ["rm", "-f", TOOL_BRIDGE_PENDING_PATH],
      { secrets: bridgeSecrets },
    );
    console.log(`[driver] ${sessionId} tool bridge response written`);
  } catch (err) {
    console.warn(`[driver] failed to write tool bridge response for ${sessionId}:`, err);
  }

  pendingToolBridgeCalls.delete(sessionId);
}

