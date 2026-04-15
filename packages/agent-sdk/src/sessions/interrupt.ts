/**
 * Interrupt handler.
 *
 * Must be called from inside the session's actor so the interrupt lands
 * between two consecutive event appends, never in the middle of one.
 */
import { getRuntime } from "../state";

export function interruptSession(sessionId: string): boolean {
  const run = getRuntime().inFlightRuns.get(sessionId);
  if (!run) return false;
  run.controller.abort(new DOMException("interrupted", "AbortError"));
  return true;
}
