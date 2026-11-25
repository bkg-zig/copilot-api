export const PROTOCOL_SNIPPET = [
  "State protocol (required): before your first tool call call GET /v1/bootstrap/{repo_id};",
  "after each completed or failed step call PUT /v1/state/{repo_id};",
  "log decisions with POST /v1/events; never push forcefully or violate hard constraints.",
].join(" ")

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export function stateToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "state_get",
      description: "Read working state for the current repository.",
      parameters: {
        type: "object",
        properties: { repo_id: { type: "string" } },
        required: ["repo_id"],
        additionalProperties: false,
      },
    },
    {
      name: "state_put",
      description: "Write working state (partial update) after a step.",
      parameters: {
        type: "object",
        properties: {
          repo_id: { type: "string" },
          branch: { type: "string" },
          commit_sha: { type: "string" },
          goal: { type: "string" },
          completed_steps: { type: "array", items: { type: "string" } },
          pending_steps: { type: "array", items: { type: "string" } },
          failed_attempts: { type: "array", items: { type: "string" } },
          active_files: { type: "array", items: { type: "string" } },
          constraints: { type: "array", items: { type: "string" } },
          tech_stack: { type: "array", items: { type: "string" } },
        },
        required: ["repo_id"],
        additionalProperties: false,
      },
    },
    {
      name: "event_log",
      description: "Append an event (step, decision, error, summary, ...).",
      parameters: {
        type: "object",
        properties: {
          repo_id: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          resolved: { type: "boolean" },
        },
        required: ["repo_id", "kind", "summary"],
        additionalProperties: false,
      },
    },
    {
      name: "bootstrap_get",
      description:
        "Fetch the deterministic bootstrap package for the repository.",
      parameters: {
        type: "object",
        properties: { repo_id: { type: "string" } },
        required: ["repo_id"],
        additionalProperties: false,
      },
    },
  ]
}
