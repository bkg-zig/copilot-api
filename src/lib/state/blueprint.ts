import type { StateEvent } from "./types"
import { anonymize, extractTokens, mergeTechStack } from "./tech-stack"

/** Event kinds that can yield a reusable blueprint. */
export function isBlueprintTrigger(event: StateEvent): boolean {
  const triggery =
    event.kind === "decision"
    || event.kind === "summary"
    || event.kind === "blueprint"
  return triggery && (event.resolved || event.kind === "blueprint")
}

export interface ExtractedBlueprint {
  title: string
  problem: string
  solution: string
  tech_stack: string[]
  tokens: string[]
}

/** Deterministic abstraction: summary + detail -> reusable blueprint. */
export function extractBlueprint(event: StateEvent): ExtractedBlueprint {
  const detailSolution =
    typeof event.detail.solution === "string" ? event.detail.solution : ""
  const detailProblem =
    typeof event.detail.problem === "string" ? event.detail.problem : ""
  const text = `${event.summary}\n${detailProblem}\n${detailSolution}`
  const problem = anonymize(detailProblem || event.summary).slice(0, 2000)
  const solution = anonymize(
    detailSolution || "Resolution recorded in cross-repo log.",
  ).slice(0, 4000)
  const tech_stack = mergeTechStack(event.tech_stack)
  return {
    title: anonymize(event.summary).slice(0, 160) || "Reusable pattern",
    problem,
    solution,
    tech_stack,
    tokens: extractTokens(text),
  }
}
