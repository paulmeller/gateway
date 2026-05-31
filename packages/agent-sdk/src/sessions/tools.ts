/**
 * Resolve an agent's `tools` array into claude --allowed-tools /
 * --disallowed-tools args plus the set of custom tool names.
 *
 * Built-in set matches the claude CLI's tool names (case-sensitive).
 */
import { BUILT_IN_TOOL_NAMES, type BuiltInToolName, type ToolConfig } from "../types";

export interface ResolvedTools {
  allowedTools: string[];
  disallowedTools: string[];
  customToolNames: Set<string>;
}

export function resolveToolset(tools: ToolConfig[]): ResolvedTools {
  const customToolNames = new Set<string>();
  let builtInEnabled = new Set<BuiltInToolName>(BUILT_IN_TOOL_NAMES);
  let hadAgentToolset = false;

  for (const tool of tools) {
    if (tool.type === "agent_toolset_20260401") {
      hadAgentToolset = true;
      const defaultEnabled = tool.default_config?.enabled ?? true;
      if (!defaultEnabled) {
        builtInEnabled = new Set();
      }
      for (const cfg of tool.configs ?? []) {
        // Normalize tool names to PascalCase — Anthropic docs show lowercase
        // ("read", "bash") but Claude Code uses PascalCase ("Read", "Bash").
        const raw = cfg.name;
        const name = BUILT_IN_TOOL_NAMES.find(
          (n) => n.toLowerCase() === raw.toLowerCase(),
        ) ?? raw;
        if (!BUILT_IN_TOOL_NAMES.includes(name as BuiltInToolName)) continue;
        if (cfg.enabled === false) {
          builtInEnabled.delete(name as BuiltInToolName);
        } else if (cfg.enabled === true) {
          builtInEnabled.add(name as BuiltInToolName);
        }
      }
    } else if (tool.type === "custom") {
      customToolNames.add(tool.name);
    }
  }

  // If no agent_toolset_20260401 was declared, start from empty built-ins.
  if (!hadAgentToolset) {
    builtInEnabled = new Set();
  }

  // ToolSearch must always be allowed, even when the agent has zero
  // built-in tools enabled. Claude Code uses it as the discovery
  // mechanism for MCP tools that are still in the "pending" state at
  // session start — if it's blocked, claude can't load MCP tool
  // schemas and dispatches all first-turn calls as synthetic
  // "No such tool available" errors. ToolSearch itself has no side
  // effects (it just returns tool schemas), so always-allowing it is
  // safe even on tightly-scoped agents.
  if (customToolNames.size > 0 && BUILT_IN_TOOL_NAMES.includes("ToolSearch" as BuiltInToolName)) {
    builtInEnabled.add("ToolSearch" as BuiltInToolName);
  }

  const allowedTools = Array.from(builtInEnabled);
  const disallowedTools = BUILT_IN_TOOL_NAMES.filter((n) => !builtInEnabled.has(n));

  return { allowedTools, disallowedTools, customToolNames };
}
