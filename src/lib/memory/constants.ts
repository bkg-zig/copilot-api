import type { MemoryTier } from "./types"

// Strength of a freshly created entry.
export const INITIAL_STRENGTH = 1
// Strength gained whenever an entry is recorded again or shown in the block.
export const BOOST = 0.5
// Cap so one hot entry cannot crowd out everything else forever.
export const MAX_STRENGTH = 4
// Entries below this strength are treated as forgotten and leave the block.
export const FORGET_FLOOR = 0.2
// A repeated action becomes procedural after this many occurrences.
export const PROCEDURAL_THRESHOLD = 3

// Strength lost per new user turn, per effective tier. The pinned goal never
// decays; procedural entries decay slowest, plain steps fastest.
export const DECAY_PER_TURN: Record<MemoryTier, number> = {
  assignment: 0.5,
  goal: 0,
  procedural: 0.03,
  semantic: 0.08,
  step: 0.34,
}

/**
 * Procedural promotion is derived, not stored: a step seen at least
 * `PROCEDURAL_THRESHOLD` times behaves like a procedural entry and decays
 * slower, without rewriting its row.
 */
export function effectiveTier(tier: MemoryTier, count: number): MemoryTier {
  return tier === "step" && count >= PROCEDURAL_THRESHOLD ? "procedural" : tier
}

// Explicit markers. They only match at the start of a line, so a normal
// sentence never accidentally rewrites the goal.
export const GOAL_MARKER = /^\s*(?:\/goal|goal|ziel)\s*[:-]\s*(.+)$/iu
export const SEMANTIC_MARKER =
  /^\s*(?:decision|fact|condition|constraint|rule|entscheidung|fakt|bedingung|regel)\s*[:-]\s*(.+)$/iu

export const DEFAULT_BUDGET = 1200
export const DEFAULT_MAX_STEPS = 6
export const DEFAULT_MAX_KNOWLEDGE = 4

// Long text is compacted before it becomes a goal or a step.
export const GOAL_MAX_CHARS = 400
export const STEP_MAX_CHARS = 240

export const BLOCK_LABELS = {
  assignment: "Auftrag",
  goal: "Ziel",
  previousGoal: "Vorheriges Ziel",
  procedural: "Verfahren",
  semantic: "Wissen",
  step: "Schritt",
} as const
