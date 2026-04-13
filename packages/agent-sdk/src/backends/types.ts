/**
 * Backend abstraction: a pluggable CLI engine that powers a session turn.
 *
 * Concrete backends (claude, opencode) implement this interface. The driver
 * resolves a Backend from the agent's `backend` field via the registry and
 * delegates argv/env/stdin construction and stream translation to it.
 *
 * Design notes:
 * - argv, env, stdin are returned as three separate primitives so the driver
 *   owns the stdin framing composition (env KEY=value lines + blank line +
 *   prompt body). This prevents each backend from reinventing the glue and
 *   silently diverging.
 * - stdin is the PROMPT BODY, not the full wrapper body. The driver composes
 *   the final wrapper stdin as `envLines + "\n\n" + stdin`. The prompt rides
 *   the HTTP request body (not the URL) — URL length caps on sprites.dev's
 *   `?cmd=...` query params are the reason we can't just put it in argv.
 *   Claude's wrapper pipes the prompt to stdin of claude; opencode's wrapper
 *   captures it into $PROMPT and re-passes it as argv to opencode (which
 *   doesn't accept stdin prompts).
 */
import type { Agent } from "../types";
import type { ContainerProvider } from "../providers/types";
import type { Translator, TranslatorOptions } from "./shared/translator-types";

/** CLI backends that have a Backend implementation in the registry */
export type CliBackendName = "claude" | "opencode" | "codex" | "gemini" | "factory";
/** All backend names including proxy-only backends */
export type AnyBackendName = CliBackendName | "anthropic";

/** @deprecated Use CliBackendName or AnyBackendName depending on context */
export type BackendName = CliBackendName;

export interface BuildTurnInput {
  agent: Agent;
  /** session id from a prior turn; null on turn 1 */
  backendSessionId: string | null;
  /** plain-text prompt text (concatenated from all pending text inputs) */
  promptText: string;
  /** tool_result inputs for backends that support mid-turn re-entry */
  toolResults: Array<{ custom_tool_use_id: string; content: unknown[] }>;
}

export interface BuildTurnResult {
  /** argv to append after the wrapper path — does NOT include the prompt text */
  argv: string[];
  /** env vars to inject via the wrapper's stdin env-read loop (auth + MCP + etc.) */
  env: Record<string, string>;
  /**
   * prompt body to send on stdin after the env block. For claude this is the
   * raw prompt OR the stream-json user frame (when toolResults is non-empty).
   * For opencode this is the wrapped prompt (system prompt prepended if set)
   * that the opencode wrapper captures via `PROMPT=$(cat)` and re-passes as
   * argv to opencode.
   */
  stdin: string;
}

export interface Backend {
  name: BackendName;
  /** Absolute path to this backend's wrapper script on the sprite */
  wrapperPath: string;
  /**
   * Build argv + env + stdin primitives for one turn of this backend.
   * The driver composes the final wrapper stdin as `envLines \n\n stdin`.
   */
  buildTurn(input: BuildTurnInput): BuildTurnResult;
  /** Stateful translator, created fresh per turn */
  createTranslator(opts: TranslatorOptions): Translator;
  /**
   * Install / verify the backend binary + wrapper on a freshly-created sprite.
   * Safe to call multiple times (idempotent via sentinels).
   */
  prepareOnSprite(spriteName: string, provider: ContainerProvider): Promise<void>;
  /**
   * Agent-create-time validation: return an error message if this backend
   * cannot run with the current config (e.g. opencode + no API key).
   */
  validateAgentCreation?(): string | null;
  /**
   * First-turn runtime validation: belt-and-braces check that the backend
   * can run NOW (config may have changed since agent create). Called from
   * the driver before acquireForFirstTurn.
   */
  validateRuntime?(): string | null;
}
