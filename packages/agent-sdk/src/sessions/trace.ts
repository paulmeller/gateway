/**
 * Trace context for observability.
 *
 * One `TraceContext` is active during a single `runTurn` invocation. It
 * carries the OTel-style trace id shared by every event of a top-level run
 * and the span id of the current "turn" span that all events emitted during
 * this run hang under.
 *
 * Lifetime rules (enforced by the driver):
 *
 *   - A fresh trace is minted when `runTurn` is invoked without a parent
 *     context (the default for new user messages).
 *
 *   - `childSpan` creates a new span inside the same trace whose parent is
 *     the current turn span. Used for:
 *       • tool_result re-entry (the custom-tool recursion path in
 *         `driver.ts`)
 *       • grader-feedback recursion (`needs_revision` from the outcome
 *         evaluator)
 *       • sub-agent spawn via `handleSpawnAgent` — the child session's
 *         `runTurn` is given the parent's current turn span as its parent
 *         so cross-session events render as one waterfall.
 *
 * Span ids are ULIDs via `newId("span")`; trace ids via `newId("trace")`.
 * Nothing reads these as opaque — they're just unique strings.
 */
import { newId } from "../util/ids";

export interface TraceContext {
  /** Shared across every event in one top-level run. */
  trace_id: string;
  /** The span that the current `runTurn` is the root of. */
  span_id: string;
  /** Parent of `span_id`. `null` for a top-level turn span. */
  parent_span_id: string | null;
}

/** Mint a brand-new trace with a fresh root turn span. */
export function newTrace(): TraceContext {
  return {
    trace_id: newId("trace"),
    span_id: newId("span"),
    parent_span_id: null,
  };
}

/**
 * Create a new span inside the same trace, parented to `parent.span_id`.
 *
 * Used whenever one `runTurn` invocation triggers another that should be
 * nested under the first's span — tool_result re-entry, grader recursion,
 * sub-agent spawns.
 */
export function childSpan(parent: TraceContext): TraceContext {
  return {
    trace_id: parent.trace_id,
    span_id: newId("span"),
    parent_span_id: parent.span_id,
  };
}
