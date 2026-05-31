/**
 * Claude backend: drives `claude -p` on sprites.dev containers.
 *
 * Implements the Backend interface over the existing claude-specific
 * args/translator/wrapper modules. `buildTurn` owns the stream-json
 * tool_result re-entry path — if `toolResults` is non-empty, it builds a
 * `{type: "user", message: {role, content: [tool_result, ...]}}` frame and
 * flips the argv to include `--input-format stream-json`.
 */
import { ApiError } from "../../errors";
import { getConfig } from "../../config";
import type { CustomTool } from "../../types";
import type { ContainerProvider } from "../../providers/types";
import type { Backend, BuildTurnInput, BuildTurnResult } from "../types";
import type { TranslatorOptions } from "../shared/translator-types";
import { buildClaudeArgs, buildClaudeAuthEnv } from "./args";
import { createClaudeTranslator } from "./translator";
import { CLAUDE_WRAPPER_PATH, installClaudeWrapper } from "./wrapper-script";
import {
  generateBridgeScript,
  buildBridgeMcpConfigFile,
  TOOL_BRIDGE_MCP_CONFIG_PATH,
  toolsToJson,
  TOOL_BRIDGE_DIR,
  TOOL_BRIDGE_SCRIPT_PATH,
  TOOL_BRIDGE_TOOLS_PATH,
} from "./tool-bridge";
import {
  generatePermissionHookScript,
  buildPermissionHooksConfig,
  PERMISSION_BRIDGE_DIR,
  PERMISSION_HOOK_SCRIPT_PATH,
} from "./permission-hook";

function buildTurn(input: BuildTurnInput): BuildTurnResult {
  const { agent, backendSessionId, promptText, toolResults } = input;

  const argsBase = buildClaudeArgs({
    agent,
    claudeSessionId: backendSessionId,
    confirmationMode: agent.confirmation_mode,
    memoryStores: input.memoryStores,
  });
  const env = buildClaudeAuthEnv();

  // With --bare, MCP servers must be passed explicitly via --mcp-config.
  // Merge the tool bridge server (if agent has custom tools) with any
  // agent-level mcp_servers into a single --mcp-config JSON blob.
  const customTools = agent.tools.filter((t): t is CustomTool => t.type === "custom");
  const hasBridgeTools = customTools.length > 0 || agent.threads_enabled;
  if (hasBridgeTools || (agent.mcp_servers && agent.mcp_servers.length > 0)) {
    // Strip any inline --mcp-config that buildClaudeArgs added (it would
    // have been for agent.mcp_servers only). We rebuild here so the
    // tool-bridge gets a file-path config and the rest goes inline.
    const mcpIdx = argsBase.indexOf("--mcp-config");
    let existingServers: Record<string, unknown> = {};
    if (mcpIdx >= 0 && mcpIdx + 1 < argsBase.length) {
      try {
        const existing = JSON.parse(argsBase[mcpIdx + 1]) as { mcpServers?: Record<string, unknown> };
        existingServers = existing.mcpServers ?? {};
      } catch {}
      argsBase.splice(mcpIdx, 2);
    }

    // File-path form: tool-bridge config is pre-written by
    // installToolBridge into the container. Inline argv had a race
    // where claude's first inference fired before MCP tool
    // registration completed, dropping the first turn's tool calls
    // as "No such tool available".
    if (hasBridgeTools) {
      argsBase.push("--mcp-config", TOOL_BRIDGE_MCP_CONFIG_PATH);
    }
    // Agent-level mcp_servers (rare) still go inline — they vary per
    // session and aren't pre-written by the bridge installer.
    if (Object.keys(existingServers).length > 0) {
      argsBase.push("--mcp-config", JSON.stringify({ mcpServers: existingServers }));
    }
    // Ignore ~/.claude/.mcp.json and similar — only use what we passed.
    argsBase.push("--strict-mcp-config");
  }

  if (toolResults.length > 0) {
    // Stream-json re-entry: claude accepts a user frame on stdin that mixes
    // text and tool_result content blocks. Spike S5 verified this works with
    // --resume + --input-format stream-json.
    const args = [...argsBase, "--input-format", "stream-json"];
    const content: Array<Record<string, unknown>> = [];
    if (promptText) {
      content.push({ type: "text", text: promptText });
    }
    for (const r of toolResults) {
      content.push({
        type: "tool_result",
        tool_use_id: r.custom_tool_use_id,
        content: r.content,
      });
    }
    const userFrame = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
    return { argv: args, env, stdin: userFrame };
  }

  return { argv: argsBase, env, stdin: promptText };
}

function validateRuntime(): string | null {
  const cfg = getConfig();
  if (!cfg.anthropicApiKey && !cfg.claudeToken) {
    // Don't fail here — the session's vault entries may provide
    // ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN at turn time.
    // The driver injects vault entries AFTER buildTurn(), so they're
    // not visible to getConfig() yet. Return null to allow the turn
    // to proceed; if no key is found at exec time, the Claude CLI
    // itself will surface the auth error in the NDJSON stream.
    return null;
  }
  return null;
}

/**
 * Install the bridge script and tools.json on the sandbox if the agent has
 * custom tools. Called from the lifecycle after the base prepareOnSandbox.
 */
async function installToolBridge(
  sandboxName: string,
  customTools: CustomTool[],
  provider: ContainerProvider,
): Promise<void> {
  if (customTools.length === 0) return;

  await provider.exec(sandboxName, ["mkdir", "-p", TOOL_BRIDGE_DIR]);
  await provider.exec(
    sandboxName,
    ["sh", "-c", `cat > "${TOOL_BRIDGE_SCRIPT_PATH}"`],
    { stdin: generateBridgeScript() },
  );
  await provider.exec(
    sandboxName,
    ["sh", "-c", `cat > "${TOOL_BRIDGE_TOOLS_PATH}"`],
    { stdin: toolsToJson(customTools) },
  );
  await provider.exec(sandboxName, ["chmod", "+x", TOOL_BRIDGE_SCRIPT_PATH]);
  // Pre-write the mcp-config JSON to disk. buildTurn passes
  // `--mcp-config <path>` (not inline JSON) — file-path form avoids
  // the inline-argv race where claude's first inference fires before
  // MCP tool registration completes.
  await provider.exec(
    sandboxName,
    ["sh", "-c", `cat > "${TOOL_BRIDGE_MCP_CONFIG_PATH}"`],
    { stdin: buildBridgeMcpConfigFile() },
  );
}

/**
 * Install the permission hook script and configure Claude Code's settings
 * to use it. Called from the lifecycle after prepareOnSandbox when the agent
 * has confirmation_mode enabled.
 */
async function installPermissionHook(
  sandboxName: string,
  provider: ContainerProvider,
): Promise<void> {
  // Create the bridge directory
  await provider.exec(sandboxName, ["mkdir", "-p", PERMISSION_BRIDGE_DIR]);

  // Write the hook script
  await provider.exec(
    sandboxName,
    ["sh", "-c", `cat > ${PERMISSION_HOOK_SCRIPT_PATH}`],
    { stdin: generatePermissionHookScript() },
  );
  await provider.exec(sandboxName, ["chmod", "+x", PERMISSION_HOOK_SCRIPT_PATH]);

  // Write the hooks config to $HOME/.claude/settings.json.
  // Claude Code reads hooks from the user's settings file at startup.
  // We need to merge with any existing settings (e.g. from prior setup).
  const hooksConfig = buildPermissionHooksConfig();

  // Resolve $HOME dynamically — avoids hardcoding /home/sprite which breaks
  // on Docker (root) and other providers where the home dir differs.
  const homeResult = await provider.exec(sandboxName, ["sh", "-c", "echo $HOME"]);
  const homeDir = homeResult.stdout.replace(/[\x00-\x1f]/g, "").trim() || "/home/sprite";
  const settingsPath = `${homeDir}/.claude/settings.json`;

  // Read existing settings if any, merge hooks config
  let existingSettings: Record<string, unknown> = {};
  try {
    const result = await provider.exec(
      sandboxName,
      ["cat", settingsPath],
    );
    if (result.stdout.trim()) {
      existingSettings = JSON.parse(result.stdout) as Record<string, unknown>;
    }
  } catch {
    // No existing settings — that's fine
  }

  const merged = { ...existingSettings, ...hooksConfig };
  await provider.exec(
    sandboxName,
    ["sh", "-c", `mkdir -p "${homeDir}/.claude" && cat > "${settingsPath}"`],
    { stdin: JSON.stringify(merged, null, 2) },
  );
}

export const claudeBackend: Backend = {
  name: "claude",
  wrapperPath: CLAUDE_WRAPPER_PATH,
  buildTurn,
  createTranslator: (opts: TranslatorOptions) => createClaudeTranslator(opts),
  prepareOnSandbox: (name: string, provider: ContainerProvider) => installClaudeWrapper(name, provider),
  validateRuntime,
  // Firecracker / Cloud Run cold-start (~1.2s Node) exceeds claude's
  // default 5s MCP server connect timeout. 30s is a safe margin.
  mcpTimeoutMs: 30_000,
  // Claude Code's --input-format stream-json + tool-bridge sentinel
  // file support custom-tool re-entry via user.custom_tool_result.
  supportsCustomTools: true,
  // Claude Code auto-discovers skills from .claude/skills/ in $HOME.
  // installSkills also writes to .agents/skills/ for cross-engine
  // compatibility (handled in lifecycle.ts).
  extraSkillDirs: [".claude/skills"],
};

// Re-export utilities needed by tests or other modules that historically
// imported them from lib/claude/*.
export {
  buildClaudeArgs,
  buildClaudeAuthEnv,
  createClaudeTranslator,
  installClaudeWrapper,
  installToolBridge,
  installPermissionHook,
  CLAUDE_WRAPPER_PATH,
};
// Re-export ApiError so the driver doesn't need to handle this indirection
export { ApiError };
