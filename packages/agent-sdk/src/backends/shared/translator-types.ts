/**
 * Shared translator contract — implemented by every backend's translator
 * (claude, opencode, ...). Decoupled from any particular CLI event shape.
 *
 * A Translator consumes raw NDJSON events from a backend CLI and produces
 * Managed Agents event payloads (unwrapped — the bus adds id/seq/etc).
 *
 * Implementations are stateful per-turn: they track the backend session id
 * so the driver can persist it and use it on the next `--resume`/`--session`
 * turn, and they track whether any custom tool was emitted so the driver can
 * flip the turn's `stop_reason` to "custom_tool_call".
 */

export type ToolClass = "builtin" | "mcp" | "custom";

export interface TranslatedEvent {
  type: string;
  payload: Record<string, unknown>;
  /**
   * Optional per-event span id override. If omitted, the driver tags the
   * event with the current turn's root span id. Translators use this to
   * emit nested spans for tool calls — `span.tool_call_start/end` with a
   * freshly-minted span id whose parent is the turn span.
   */
  spanId?: string;
  /**
   * Optional parent span override. Only meaningful alongside `spanId` —
   * e.g. `span.tool_call_start` sets `parentSpanId` to the turn's root
   * span id so the tool span nests under the turn.
   */
  parentSpanId?: string;
}

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cost_usd: number;
}

export interface TurnResult {
  stopReason: "end_turn" | "max_turns" | "error" | "custom_tool_call";
  usage: TurnUsage;
  num_turns: number;
}

export interface Translator {
  /**
   * Consume a single raw CLI NDJSON event and return zero or more Managed
   * Agents event payloads. These are appended to the session via
   * `bus.appendEventsBatch` by the driver.
   */
  translate(raw: Record<string, unknown>): TranslatedEvent[];

  /**
   * Latest backend session id observed so far (claude `system.init.session_id`
   * or opencode `sessionID`). Exposed so the driver can persist it and use
   * it on the next turn's resume flag.
   */
  getBackendSessionId(): string | null;

  /** Summarize the turn from the most recent `result` event for the driver */
  getTurnResult(): TurnResult | null;

  /** True if any custom tool was emitted during this turn */
  sawCustomToolUse(): boolean;
}

export interface TranslatorOptions {
  /**
   * Names of custom tools defined on the agent. Used to classify tool_use
   * events the translator doesn't otherwise recognize.
   */
  customToolNames: Set<string>;

  /**
   * True if this is the first turn of the session. Controls whether
   * `system.init`-equivalent events trigger status_running (first turn only).
   */
  isFirstTurn: boolean;

  /**
   * Observability: the turn's root span id. When provided, translators
   * may mint child spans for tool calls with `parentSpanId = turnSpanId`
   * so the full trace tree is recoverable. Optional for
   * backward-compatibility with older callers; legacy translators that
   * don't emit per-tool spans simply ignore it.
   */
  turnSpanId?: string;
}
