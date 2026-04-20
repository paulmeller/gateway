/**
 * Global mutable runtime state — HMR-safe via globalThis so Next.js dev
 * reloads don't duplicate maps.
 */

export interface InFlightRun {
  sessionId: string;
  controller: AbortController;
  startedAt: number;
}

export type TurnInput =
  | { kind: "text"; eventId: string; text: string }
  | {
      kind: "tool_result";
      eventId: string;
      custom_tool_use_id: string;
      content: unknown[];
    };

export interface PendingUserInput {
  sessionId: string;
  input: TurnInput;
}

type RuntimeState = {
  inFlightRuns: Map<string, InFlightRun>;
  pendingUserInputs: Map<string, TurnInput[]>;
};

type GlobalState = typeof globalThis & {
  __caRuntime?: RuntimeState;
};

export function getRuntime(): RuntimeState {
  const g = globalThis as GlobalState;
  if (!g.__caRuntime) {
    g.__caRuntime = {
      inFlightRuns: new Map(),
      pendingUserInputs: new Map(),
    };
  }
  return g.__caRuntime;
}

export function pushPendingUserInput(input: PendingUserInput): void {
  const rt = getRuntime();
  const list = rt.pendingUserInputs.get(input.sessionId) ?? [];
  list.push(input.input);
  rt.pendingUserInputs.set(input.sessionId, list);
}

export function drainPendingUserInputs(sessionId: string): TurnInput[] {
  const rt = getRuntime();
  const list = rt.pendingUserInputs.get(sessionId) ?? [];
  rt.pendingUserInputs.delete(sessionId);
  return list;
}
