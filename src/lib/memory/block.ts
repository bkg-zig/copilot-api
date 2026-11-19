import { BLOCK_LABELS, FORGET_FLOOR, effectiveTier } from "./constants"
import type {
  MemoryBlock,
  MemoryBlockOptions,
  MemoryEntry,
  MemoryTier,
} from "./types"

interface Candidate {
  entry: MemoryEntry
  line: string
  strength: number
}

function byStrength(a: Candidate, b: Candidate): number {
  if (b.strength !== a.strength) return b.strength - a.strength
  return b.entry.lastSeenAt - a.entry.lastSeenAt
}

/**
 * Pure, deterministic working-block builder. It never calls a model: it picks
 * the pinned goal, the previous goal, and the strongest steps/knowledge that
 * still fit the character budget, then returns the block text plus the ids
 * that were used (so the caller can apply the visibility boost).
 */
export function buildMemoryBlock(input: {
  projectId: string
  sessionId: string
  entries: Array<MemoryEntry>
  options: MemoryBlockOptions
}): MemoryBlock {
  const { entries, options, projectId, sessionId } = input
  const visible = entries.filter(
    (entry) => entry.pinned || entry.strength >= FORGET_FLOOR,
  )

  const goalEntry =
    visible
      .filter((entry) => entry.tier === "goal" && entry.pinned)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  const previousGoalEntry =
    visible
      .filter((entry) => entry.tier === "goal" && !entry.pinned)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null

  const stepPool: Array<Candidate> = []
  const knowledgePool: Array<Candidate> = []
  const otherPool: Array<Candidate> = []

  for (const entry of visible) {
    const tier: MemoryTier = effectiveTier(entry.tier, entry.count)
    if (tier === "goal") continue
    const line = `- ${BLOCK_LABELS[tier]}: ${entry.text}`
    const candidate: Candidate = { entry, line, strength: entry.strength }
    if (tier === "step") {
      if (sessionId === "" || entry.sessionId === sessionId)
        stepPool.push(candidate)
    } else if (tier === "semantic" || tier === "procedural") {
      knowledgePool.push(candidate)
    } else if (sessionId === "" || entry.sessionId === sessionId) {
      otherPool.push(candidate)
    }
  }

  stepPool.sort(byStrength)
  knowledgePool.sort(byStrength)
  otherPool.sort(byStrength)

  const chosen = [
    ...stepPool.slice(0, options.maxSteps),
    ...knowledgePool.slice(0, options.maxKnowledge),
    ...otherPool,
  ].sort(byStrength)

  const parts: Array<string> = []
  const lines: Array<string> = []
  const usedIds: Array<string> = []
  if (goalEntry) {
    parts.push(`${BLOCK_LABELS.goal}: ${goalEntry.text}`)
    usedIds.push(goalEntry.id)
  }
  if (previousGoalEntry) {
    parts.push(`${BLOCK_LABELS.previousGoal}: ${previousGoalEntry.text}`)
  }

  let length = parts.join("\n").length
  let truncated = false
  for (const candidate of chosen) {
    const nextLength = length + 1 + candidate.line.length
    if (nextLength > options.budget) {
      truncated = true
      break
    }
    parts.push(candidate.line)
    lines.push(candidate.line)
    usedIds.push(candidate.entry.id)
    length = nextLength
  }

  return {
    goal: goalEntry?.text ?? null,
    lines,
    previousGoal: previousGoalEntry?.text ?? null,
    projectId,
    sessionId,
    text: parts.join("\n"),
    truncated,
    usedIds,
  }
}
