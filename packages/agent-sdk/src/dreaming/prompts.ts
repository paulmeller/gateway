/**
 * Dreaming prompts — system prompt and tool definition for memory curation.
 */

export const DREAMING_SYSTEM_PROMPT = `You are a memory curator for an AI agent platform. You review recent agent sessions to identify patterns and improve the agent's memory store.

Your job:
1. Analyze session transcripts for recurring patterns, mistakes, preferences, and learnings
2. Compare against the current memory store contents
3. Propose memory updates that will help agents perform better in future sessions

Output your proposed changes using the update_memories tool. Each change should have:
- operation: "create" (new memory), "update" (modify existing), or "delete" (remove outdated)
- path: the memory file path (e.g., "/preferences/formatting.md", "/patterns/common-errors.md")
- content: the new content (for create/update)
- reason: why this change improves agent performance

Guidelines:
- Structure memories as small, focused files (one topic per file)
- Keep memory files under 100KB
- Use clear, descriptive paths
- Don't create memories for one-off events — focus on patterns
- Update existing memories when new information refines them
- Delete memories that are outdated or contradicted by recent sessions
- Focus on actionable knowledge the agent can use`;

export const UPDATE_MEMORIES_TOOL = {
  name: "update_memories",
  description: "Propose changes to the memory store based on session analysis",
  input_schema: {
    type: "object" as const,
    properties: {
      changes: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            operation: { type: "string" as const, enum: ["create", "update", "delete"] },
            path: { type: "string" as const },
            content: { type: "string" as const },
            reason: { type: "string" as const },
          },
          required: ["operation", "path", "reason"],
        },
      },
    },
    required: ["changes"],
  },
};
