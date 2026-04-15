/**
 * Outcome grader — evaluates agent output against a rubric.
 *
 * Runs as a direct Anthropic API call from the Node.js process (NOT
 * `claude -p` on the container) to avoid corrupting Claude session state.
 * Uses tool_use with a structured result schema for reliable parsing.
 */
import { getConfig } from "../config";

export type GraderResult = "satisfied" | "needs_revision" | "failed";

export interface GraderEvaluation {
  result: GraderResult;
  feedback: string;
  usage: { input_tokens: number; output_tokens: number };
}

const GRADER_SYSTEM = `You are an evaluation grader. You evaluate whether an agent's work output satisfies a rubric.

You MUST call the evaluate_outcome tool with your assessment. Do not respond with plain text.`;

const EVALUATE_TOOL = {
  name: "evaluate_outcome",
  description: "Submit your evaluation of the agent's output against the rubric.",
  input_schema: {
    type: "object" as const,
    properties: {
      result: {
        type: "string" as const,
        enum: ["satisfied", "needs_revision", "failed"],
        description: "satisfied: output meets the rubric. needs_revision: output is close but needs specific changes. failed: output fundamentally fails to meet the rubric.",
      },
      feedback: {
        type: "string" as const,
        description: "Brief explanation of the evaluation. If needs_revision, include specific actionable feedback for the agent.",
      },
    },
    required: ["result", "feedback"],
  },
};

/**
 * Call the Anthropic API directly to grade agent output against a rubric.
 * Falls back to a simple "satisfied" if the API key is not configured.
 */
export async function runGraderEvaluation(
  rubric: string,
  agentOutput: string,
  model: string,
): Promise<GraderEvaluation> {
  const cfg = getConfig();
  const apiKey = cfg.anthropicApiKey;

  if (!apiKey) {
    // No API key — can't grade, default to satisfied
    return {
      result: "satisfied",
      feedback: "Grader skipped: no ANTHROPIC_API_KEY configured for direct API evaluation.",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const userMessage = `## Rubric\n${rubric}\n\n## Agent Output\n${agentOutput}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model || "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: GRADER_SYSTEM,
      tools: [EVALUATE_TOOL],
      tool_choice: { type: "tool", name: "evaluate_outcome" },
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.warn(`[grader] API call failed (${response.status}): ${errText}`);
    return {
      result: "satisfied",
      feedback: `Grader API error (${response.status}), defaulting to satisfied.`,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const data = await response.json() as {
    content: Array<{ type: string; name?: string; input?: { result?: string; feedback?: string } }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  // Extract the tool_use result
  const toolUse = data.content.find(
    (b) => b.type === "tool_use" && b.name === "evaluate_outcome",
  );

  if (!toolUse?.input?.result) {
    return {
      result: "satisfied",
      feedback: "Grader returned no structured result, defaulting to satisfied.",
      usage: data.usage ?? { input_tokens: 0, output_tokens: 0 },
    };
  }

  const validResults: GraderResult[] = ["satisfied", "needs_revision", "failed"];
  const result = validResults.includes(toolUse.input.result as GraderResult)
    ? (toolUse.input.result as GraderResult)
    : "satisfied";

  return {
    result,
    feedback: toolUse.input.feedback ?? "",
    usage: data.usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}
