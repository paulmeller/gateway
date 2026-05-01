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
  buildBridgeMcpConfig,
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
  });
  const env = buildClaudeAuthEnv();

  // With --bare, MCP servers must be passed explicitly via --mcp-config.
  // Merge the tool bridge server (if agent has custom tools) with any
  // agent-level mcp_servers into a single --mcp-config JSON blob.
  const customTools = agent.tools.filter((t): t is CustomTool => t.type === "custom");
  const hasBridgeTools = customTools.length > 0 || agent.threads_enabled;
  if (hasBridgeTools || (agent.mcp_servers && Object.keys(agent.mcp_servers).length > 0)) {
    const mcpIdx = argsBase.indexOf("--mcp-config");
    let existingServers: Record<string, unknown> = {};
    if (mcpIdx >= 0 && mcpIdx + 1 < argsBase.length) {
      try {
        const existing = JSON.parse(argsBase[mcpIdx + 1]) as { mcpServers?: Record<string, unknown> };
        existingServers = existing.mcpServers ?? {};
      } catch {}
      argsBase.splice(mcpIdx, 2);
    }
    const merged = hasBridgeTools ? buildBridgeMcpConfig(existingServers) : existingServers;
    argsBase.push("--mcp-config", JSON.stringify({ mcpServers: merged }));
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
    ["bash", "-c", `cat > ${PERMISSION_HOOK_SCRIPT_PATH}`],
    { stdin: generatePermissionHookScript() },
  );
  await provider.exec(sandboxName, ["chmod", "+x", PERMISSION_HOOK_SCRIPT_PATH]);

  // Write the hooks config to $HOME/.claude/settings.json.
  // Claude Code reads hooks from the user's settings file at startup.
  // We need to merge with any existing settings (e.g. from prior setup).
  const hooksConfig = buildPermissionHooksConfig();
  const settingsPath = "/home/sprite/.claude/settings.json";

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
    ["bash", "-c", `mkdir -p /home/sprite/.claude && cat > ${settingsPath}`],
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
