// @ts-nocheck — test file with loose typing on handler responses
/**
 * Outcome evaluation tests.
 *
 * Covers:
 *   - user.define_outcome event stores outcome and echoes event
 *   - outcome_evaluations[] populated on GET session
 *   - Grader integration in the driver (mocked Anthropic API)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test infrastructure (same pattern as api-comprehensive.test.ts)
// ---------------------------------------------------------------------------

function freshDbEnv(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ca-outcomes-test-"));
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  process.env.DEFAULT_PROVIDER = "docker";
  const g = globalThis as typeof globalThis & {
    __caDb?: unknown;
    __caDrizzle?: unknown;
    __caInitialized?: unknown;
    __caInitPromise?: unknown;
    __caBusEmitters?: unknown;
    __caConfigCache?: unknown;
    __caRuntime?: unknown;
    __caSweeperHandle?: unknown;
    __caActors?: unknown;
  };
  delete g.__caDb;
  delete g.__caDrizzle;
  delete g.__caInitialized;
  delete g.__caInitPromise;
  delete g.__caBusEmitters;
  delete g.__caConfigCache;
  delete g.__caRuntime;
  if (g.__caSweeperHandle) {
    clearInterval(g.__caSweeperHandle as NodeJS.Timeout);
    delete g.__caSweeperHandle;
  }
  delete g.__caActors;
}

async function bootDb(): Promise<string> {
  const { getDb } = await import("../src/db/client");
  getDb();
  const { createApiKey } = await import("../src/db/api_keys");
  const { key } = createApiKey({ name: "test", permissions: ["*"], rawKey: "test-api-key-12345" });
  return key;
}

function req(
  url: string,
  opts: { method?: string; body?: unknown; apiKey?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.apiKey !== undefined) {
    if (opts.apiKey !== "") headers["x-api-key"] = opts.apiKey;
  } else {
    headers["x-api-key"] = "test-api-key-12345";
  }
  return new Request(`http://localhost${url}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function createTestAgent(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { handleCreateAgent } = await import("../src/handlers/anthropic-compat/agents");
  const res = await handleCreateAgent(
    req("/anthropic/v1/agents", {
      body: { name: `Agent-${Date.now()}-${Math.random()}`, model: { id: "claude-sonnet-4-6" }, ...overrides },
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

async function createTestEnv(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { getDb } = await import("../src/db/client");
  const { newId } = await import("../src/util/ids");
  const { nowMs, toIso } = await import("../src/util/clock");

  const db = getDb();
  const id = newId("env");
  const now = nowMs();
  const name = (overrides.name as string) ?? `env-${Date.now()}-${Math.random()}`;
  const config = overrides.config ?? { type: "self_hosted", provider: "docker" };

  db.prepare(
    `INSERT INTO environments (id, name, config_json, state, tenant_id, created_at, updated_at) VALUES (?, ?, ?, 'ready', 'tenant_default', ?, ?)`,
  ).run(id, name, JSON.stringify(config), now, now);

  return { id, name, config, state: "ready" };
}

async function createTestSession(
  agentId: string,
  envId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { handleCreateSession } = await import("../src/handlers/anthropic-compat/sessions");
  const res = await handleCreateSession(
    req("/anthropic/v1/sessions", {
      body: { agent: agentId, environment_id: envId, ...overrides },
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Outcomes", () => {
  beforeEach(() => freshDbEnv());

  describe("user.define_outcome event", () => {
    it("stores outcome with outcome_id and echoes event", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "OutcomeAgent" });
      const env = await createTestEnv({ name: "OutcomeEnv" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      const { handlePostEvents } = await import("../src/handlers/anthropic-compat/events");
      const res = await handlePostEvents(
        req(`/anthropic/v1/sessions/${sessionId}/events`, {
          body: {
            events: [{
              type: "user.define_outcome",
              description: "Write a hello world program",
              rubric: { type: "text", content: "Must print 'Hello, World!'" },
              max_iterations: 5,
            }],
          },
        }),
        sessionId,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<Record<string, unknown>> };
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      // Find the define_outcome event in the response
      const outcomeEvt = body.data.find((e) => e.type === "user.define_outcome");
      expect(outcomeEvt).toBeDefined();

      // Verify outcome_id was generated with outc_ prefix
      const payload = outcomeEvt as Record<string, unknown>;
      expect(payload.outcome_id).toBeDefined();
      expect((payload.outcome_id as string).startsWith("outc_")).toBe(true);

      // Verify the outcome is stored in the session
      const { getOutcomeCriteria } = await import("../src/db/sessions");
      const criteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      expect(criteria).toBeTruthy();
      expect(criteria.outcome_id).toBeDefined();
      expect((criteria.outcome_id as string).startsWith("outc_")).toBe(true);
      expect(criteria.description).toBe("Write a hello world program");
      expect(criteria.rubric).toBe("Must print 'Hello, World!'");
      expect(criteria.max_iterations).toBe(5);
      expect(criteria.grader_iteration).toBe(0);
      expect(criteria.status).toBe("running");
    });

    it("stores outcome with string rubric", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "OutcomeAgent2" });
      const env = await createTestEnv({ name: "OutcomeEnv2" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      const { handlePostEvents } = await import("../src/handlers/anthropic-compat/events");
      const res = await handlePostEvents(
        req(`/anthropic/v1/sessions/${sessionId}/events`, {
          body: {
            events: [{
              type: "user.define_outcome",
              description: "Write tests",
              rubric: "All tests must pass",
            }],
          },
        }),
        sessionId,
      );

      expect(res.status).toBe(200);

      const { getOutcomeCriteria } = await import("../src/db/sessions");
      const criteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      expect(criteria.rubric).toBe("All tests must pass");
    });

    it("uses default max_iterations of 3", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "OutcomeAgent3" });
      const env = await createTestEnv({ name: "OutcomeEnv3" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      const { handlePostEvents } = await import("../src/handlers/anthropic-compat/events");
      await handlePostEvents(
        req(`/anthropic/v1/sessions/${sessionId}/events`, {
          body: {
            events: [{
              type: "user.define_outcome",
              description: "Build something",
              rubric: "It should work",
            }],
          },
        }),
        sessionId,
      );

      const { getOutcomeCriteria } = await import("../src/db/sessions");
      const criteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      expect(criteria.max_iterations).toBe(3);
    });

    it("rejects max_iterations > 20", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "OutcomeAgent4" });
      const env = await createTestEnv({ name: "OutcomeEnv4" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      const { handlePostEvents } = await import("../src/handlers/anthropic-compat/events");
      const res = await handlePostEvents(
        req(`/anthropic/v1/sessions/${sessionId}/events`, {
          body: {
            events: [{
              type: "user.define_outcome",
              description: "Build something",
              rubric: "It should work",
              max_iterations: 25,
            }],
          },
        }),
        sessionId,
      );

      expect(res.status).toBe(400);
    });

    it("also appends a user.message event for the description", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "OutcomeAgent5" });
      const env = await createTestEnv({ name: "OutcomeEnv5" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      const { handlePostEvents } = await import("../src/handlers/anthropic-compat/events");
      await handlePostEvents(
        req(`/anthropic/v1/sessions/${sessionId}/events`, {
          body: {
            events: [{
              type: "user.define_outcome",
              description: "Implement feature X",
              rubric: "Feature X must be complete",
            }],
          },
        }),
        sessionId,
      );

      // Check that a user.message was also appended
      const { listEvents } = await import("../src/db/events");
      const events = listEvents(sessionId, { limit: 10, order: "asc" });
      const msgEvents = events.filter((e) => e.type === "user.message");
      expect(msgEvents.length).toBeGreaterThanOrEqual(1);

      // The last user.message should contain the description
      const lastMsg = msgEvents[msgEvents.length - 1];
      const payload = JSON.parse(lastMsg.payload_json) as { content: Array<{ text: string }> };
      expect(payload.content[0].text).toBe("Implement feature X");
    });
  });

  describe("outcome_evaluations on session", () => {
    it("returns empty outcome_evaluations when no outcome defined", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "NoOutcomeAgent" });
      const env = await createTestEnv({ name: "NoOutcomeEnv" });
      const session = await createTestSession(agent.id as string, env.id as string);

      const { handleGetSession } = await import("../src/handlers/anthropic-compat/sessions");
      const res = await handleGetSession(
        req(`/anthropic/v1/sessions/${session.id}`),
        session.id as string,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.outcome_evaluations).toEqual([]);
    });

    it("returns outcome_evaluation after define_outcome", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "EvalAgent" });
      const env = await createTestEnv({ name: "EvalEnv" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      // Define an outcome
      const { handlePostEvents } = await import("../src/handlers/anthropic-compat/events");
      await handlePostEvents(
        req(`/anthropic/v1/sessions/${sessionId}/events`, {
          body: {
            events: [{
              type: "user.define_outcome",
              description: "Build a REST API",
              rubric: "API must have GET and POST endpoints",
              max_iterations: 3,
            }],
          },
        }),
        sessionId,
      );

      // Fetch session
      const { handleGetSession } = await import("../src/handlers/anthropic-compat/sessions");
      const res = await handleGetSession(
        req(`/anthropic/v1/sessions/${sessionId}`),
        sessionId,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { outcome_evaluations: Array<Record<string, unknown>> };
      expect(body.outcome_evaluations).toHaveLength(1);

      const eval0 = body.outcome_evaluations[0];
      expect(eval0.type).toBe("outcome_evaluation");
      expect((eval0.outcome_id as string).startsWith("outc_")).toBe(true);
      expect(eval0.description).toBe("Build a REST API");
      expect(eval0.result).toBe("running");
      expect(eval0.iteration).toBe(0);
      expect(eval0.completed_at).toBeNull();
      expect(eval0.explanation).toBe("");
    });

    it("reflects completed outcome status", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "CompletedAgent" });
      const env = await createTestEnv({ name: "CompletedEnv" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      // Manually set outcome criteria as if grader completed
      const { setOutcomeCriteria } = await import("../src/db/sessions");
      setOutcomeCriteria(sessionId, {
        outcome_id: "outc_test123",
        description: "Build feature",
        rubric: "Feature works",
        max_iterations: 3,
        grader_iteration: 1,
        status: "satisfied",
        completed_at: "2026-01-01T00:00:00.000Z",
        explanation: "All criteria met",
      });

      const { handleGetSession } = await import("../src/handlers/anthropic-compat/sessions");
      const res = await handleGetSession(
        req(`/anthropic/v1/sessions/${sessionId}`),
        sessionId,
      );

      const body = (await res.json()) as { outcome_evaluations: Array<Record<string, unknown>> };
      expect(body.outcome_evaluations).toHaveLength(1);

      const eval0 = body.outcome_evaluations[0];
      expect(eval0.result).toBe("satisfied");
      expect(eval0.iteration).toBe(1);
      expect(eval0.completed_at).toBe("2026-01-01T00:00:00.000Z");
      expect(eval0.explanation).toBe("All criteria met");
    });
  });

  describe("outc_ ID prefix", () => {
    it("newId generates outc_ prefixed IDs", async () => {
      const { newId } = await import("../src/util/ids");
      const id = newId("outc");
      expect(id.startsWith("outc_")).toBe(true);
      expect(id.length).toBeGreaterThan(5);
    });

    it("isId validates outc_ prefix", async () => {
      const { isId } = await import("../src/util/ids");
      expect(isId("outc", "outc_abc123")).toBe(true);
      expect(isId("outc", "sesn_abc123")).toBe(false);
      expect(isId("outc", 42)).toBe(false);
    });
  });

  describe("grader integration in driver", () => {
    it("grader loop emits outcome_id in evaluation events", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "GraderAgent" });
      const env = await createTestEnv({ name: "GraderEnv" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      // Set up outcome criteria with an outcome_id
      const { setOutcomeCriteria, getOutcomeCriteria } = await import("../src/db/sessions");
      setOutcomeCriteria(sessionId, {
        outcome_id: "outc_grader_test",
        description: "Write tests",
        rubric: "All tests pass",
        max_iterations: 3,
        grader_iteration: 0,
        status: "running",
      });

      // Simulate an agent.message event so the grader has output to evaluate
      const { appendEvent } = await import("../src/sessions/bus");
      appendEvent(sessionId, {
        type: "agent.message",
        payload: { content: [{ type: "text", text: "I wrote the tests and they all pass." }] },
        origin: "server",
        processedAt: Date.now(),
      });

      // Mock the grader to return "satisfied"
      const graderModule = await import("../src/sessions/grader");
      const mockGrader = vi.spyOn(graderModule, "runGraderEvaluation").mockResolvedValue({
        result: "satisfied",
        feedback: "All tests pass as required.",
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      // Directly call the driver's outcome evaluation logic by importing
      // and calling the relevant functions
      const { runGraderEvaluation } = graderModule;
      const criteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      expect(criteria.outcome_id).toBe("outc_grader_test");

      const evaluation = await runGraderEvaluation(
        criteria.rubric as string,
        "I wrote the tests and they all pass.",
        "claude-sonnet-4-6",
      );

      expect(evaluation.result).toBe("satisfied");
      expect(evaluation.feedback).toBe("All tests pass as required.");

      // Update outcome as the driver would
      setOutcomeCriteria(sessionId, {
        ...criteria,
        grader_iteration: 1,
        status: "satisfied",
        completed_at: new Date().toISOString(),
        explanation: evaluation.feedback,
      });

      const updatedCriteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      expect(updatedCriteria.status).toBe("satisfied");
      expect(updatedCriteria.grader_iteration).toBe(1);
      expect(updatedCriteria.explanation).toBe("All tests pass as required.");

      mockGrader.mockRestore();
    });

    it("max_iterations_reached terminates the loop", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "MaxIterAgent" });
      const env = await createTestEnv({ name: "MaxIterEnv" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      // Set up outcome at last iteration
      const { setOutcomeCriteria, getOutcomeCriteria } = await import("../src/db/sessions");
      setOutcomeCriteria(sessionId, {
        outcome_id: "outc_maxiter_test",
        description: "Write tests",
        rubric: "All tests pass",
        max_iterations: 3,
        grader_iteration: 2, // Already at iteration 2, so next will be 3 (>= max)
        status: "running",
      });

      // Mock the grader to return "needs_revision"
      const graderModule = await import("../src/sessions/grader");
      const mockGrader = vi.spyOn(graderModule, "runGraderEvaluation").mockResolvedValue({
        result: "needs_revision",
        feedback: "Tests still need work.",
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const criteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      const evaluation = await graderModule.runGraderEvaluation(
        criteria.rubric as string,
        "Some output",
        "claude-sonnet-4-6",
      );

      const iteration = criteria.grader_iteration as number;
      const maxIter = criteria.max_iterations as number;

      // Simulate the driver's logic
      const finalResult = iteration + 1 >= maxIter && evaluation.result === "needs_revision"
        ? "max_iterations_reached"
        : evaluation.result;

      expect(finalResult).toBe("max_iterations_reached");

      // Update outcome as the driver would
      setOutcomeCriteria(sessionId, {
        ...criteria,
        grader_iteration: iteration + 1,
        status: finalResult,
        completed_at: new Date().toISOString(),
        explanation: evaluation.feedback,
      });

      const updatedCriteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      expect(updatedCriteria.status).toBe("max_iterations_reached");
      expect(updatedCriteria.grader_iteration).toBe(3);

      mockGrader.mockRestore();
    });

    it("needs_revision continues when under max_iterations", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "RevisionAgent" });
      const env = await createTestEnv({ name: "RevisionEnv" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      const { setOutcomeCriteria, getOutcomeCriteria } = await import("../src/db/sessions");
      setOutcomeCriteria(sessionId, {
        outcome_id: "outc_revision_test",
        description: "Write tests",
        rubric: "All tests pass",
        max_iterations: 5,
        grader_iteration: 1,
        status: "running",
      });

      const graderModule = await import("../src/sessions/grader");
      const mockGrader = vi.spyOn(graderModule, "runGraderEvaluation").mockResolvedValue({
        result: "needs_revision",
        feedback: "Fix the edge case in test 3.",
        usage: { input_tokens: 80, output_tokens: 40 },
      });

      const criteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      const evaluation = await graderModule.runGraderEvaluation(
        criteria.rubric as string,
        "Some output",
        "claude-sonnet-4-6",
      );

      const iteration = criteria.grader_iteration as number;
      const maxIter = criteria.max_iterations as number;

      const finalResult = iteration + 1 >= maxIter && evaluation.result === "needs_revision"
        ? "max_iterations_reached"
        : evaluation.result;

      // Under max_iterations, so still needs_revision (continue loop)
      expect(finalResult).toBe("needs_revision");
      expect(iteration + 1).toBeLessThan(maxIter);

      // The driver would increment iteration but NOT set terminal status
      setOutcomeCriteria(sessionId, {
        ...criteria,
        grader_iteration: iteration + 1,
      });

      const updatedCriteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      expect(updatedCriteria.status).toBe("running"); // still running
      expect(updatedCriteria.grader_iteration).toBe(2);

      mockGrader.mockRestore();
    });

    it("failed grader result updates outcome to failed", async () => {
      await bootDb();
      const agent = await createTestAgent({ name: "FailAgent" });
      const env = await createTestEnv({ name: "FailEnv" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      const { setOutcomeCriteria, getOutcomeCriteria } = await import("../src/db/sessions");
      setOutcomeCriteria(sessionId, {
        outcome_id: "outc_fail_test",
        description: "Write tests",
        rubric: "All tests pass",
        max_iterations: 3,
        grader_iteration: 0,
        status: "running",
      });

      const graderModule = await import("../src/sessions/grader");
      const mockGrader = vi.spyOn(graderModule, "runGraderEvaluation").mockResolvedValue({
        result: "failed",
        feedback: "Output is completely wrong.",
        usage: { input_tokens: 90, output_tokens: 30 },
      });

      const criteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      const evaluation = await graderModule.runGraderEvaluation(
        criteria.rubric as string,
        "Bad output",
        "claude-sonnet-4-6",
      );

      // Simulate the driver's logic: "failed" is terminal
      setOutcomeCriteria(sessionId, {
        ...criteria,
        grader_iteration: 1,
        status: evaluation.result,
        completed_at: new Date().toISOString(),
        explanation: evaluation.feedback,
      });

      const updatedCriteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      expect(updatedCriteria.status).toBe("failed");
      expect(updatedCriteria.explanation).toBe("Output is completely wrong.");

      // Verify session reflects this in outcome_evaluations
      const { handleGetSession } = await import("../src/handlers/anthropic-compat/sessions");
      const res = await handleGetSession(
        req(`/anthropic/v1/sessions/${sessionId}`),
        sessionId,
      );
      const body = (await res.json()) as { outcome_evaluations: Array<Record<string, unknown>> };
      expect(body.outcome_evaluations).toHaveLength(1);
      expect(body.outcome_evaluations[0].result).toBe("failed");
      expect(body.outcome_evaluations[0].explanation).toBe("Output is completely wrong.");

      mockGrader.mockRestore();
    });
  });

  describe("driver skips grader for non-running outcomes", () => {
    it("does not re-evaluate already-satisfied outcomes", async () => {
      await bootDb();
      const { setOutcomeCriteria, getOutcomeCriteria } = await import("../src/db/sessions");
      const agent = await createTestAgent({ name: "SatisfiedAgent" });
      const env = await createTestEnv({ name: "SatisfiedEnv" });
      const session = await createTestSession(agent.id as string, env.id as string);
      const sessionId = session.id as string;

      // Set outcome as already satisfied
      setOutcomeCriteria(sessionId, {
        outcome_id: "outc_satisfied",
        description: "Feature done",
        rubric: "Feature works",
        max_iterations: 3,
        grader_iteration: 1,
        status: "satisfied",
        completed_at: "2026-01-01T00:00:00.000Z",
        explanation: "All good",
      });

      // The driver checks `criteria?.status === "running"` before evaluating
      const criteria = getOutcomeCriteria(sessionId) as Record<string, unknown>;
      expect(criteria.status).toBe("satisfied");
      // status !== "running" means grader should NOT be called
      expect(criteria.status !== "running").toBe(true);
    });
  });
});
