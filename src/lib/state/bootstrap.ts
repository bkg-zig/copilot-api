import { getStateConfig } from "./config"
import { PROTOCOL_SNIPPET } from "./protocol"

import type { Blueprint, BootstrapPackage, WorkingState } from "./types"

export interface BuildBootstrapInput {
  repo_id: string
  state: WorkingState | null
  blueprints: Blueprint[]
  extraConstraints?: string[]
}

/** Pure, deterministic builder: constraints -> state -> blueprints -> protocol. */
export function buildBootstrapPackage(
  input: BuildBootstrapInput,
): BootstrapPackage {
  const config = getStateConfig()
  const base = (config.constraints[input.repo_id] ?? [])
    .map((item) => String(item).trim())
    .filter(Boolean)
  const fromState = (input.state?.constraints ?? [])
    .map((item) => String(item).trim())
    .filter(Boolean)
  const extra = (input.extraConstraints ?? [])
    .map((item) => String(item).trim())
    .filter(Boolean)
  const constraints = [...base, ...fromState, ...extra]

  const lines: string[] = ["# Bootstrap", ""]
  lines.push("## Hard constraints")
  if (constraints.length === 0) {
    lines.push("- (none)")
  } else {
    for (const item of constraints) {
      lines.push(`- ${item}`)
    }
  }
  lines.push("")
  lines.push("## Repo state")
  const state = input.state
  if (!state) {
    lines.push("- (no working state yet — call PUT /v1/state first)")
  } else {
    lines.push(`- branch: ${state.branch || "(unknown)"}`)
    lines.push(`- commit: ${state.commit_sha || "(unknown)"}`)
    lines.push(`- goal: ${state.goal || "(unset)"}`)
    lines.push(`- completed: ${state.completed_steps.join("; ") || "(none)"}`)
    lines.push(`- pending: ${state.pending_steps.join("; ") || "(none)"}`)
    lines.push(`- failed: ${state.failed_attempts.join("; ") || "(none)"}`)
    lines.push(`- active files: ${state.active_files.join(", ") || "(none)"}`)
    lines.push(`- tech stack: ${state.tech_stack.join(", ") || "(none)"}`)
    lines.push(
      `- last model: ${state.last_model || "(unknown)"}, revision ${state.revision}`,
    )
  }
  lines.push("")
  lines.push("## Reusable blueprints")
  if (input.blueprints.length === 0) {
    lines.push("- (none)")
  } else {
    for (const blueprint of input.blueprints) {
      lines.push(`### ${blueprint.title}`)
      lines.push(`Problem: ${blueprint.problem}`)
      lines.push(`Solution: ${blueprint.solution}`)
      if (blueprint.tech_stack.length > 0) {
        lines.push(`Stack: ${blueprint.tech_stack.join(", ")}`)
      }
      lines.push("")
    }
  }
  lines.push("## Protocol")
  lines.push(PROTOCOL_SNIPPET)

  return {
    repo_id: input.repo_id,
    constraints,
    state,
    blueprints: input.blueprints,
    protocol_snippet: PROTOCOL_SNIPPET,
    markdown: lines.join("\n"),
  }
}
