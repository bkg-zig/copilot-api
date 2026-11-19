// Goal-anchored memory: types.
//
// The model keeps a pinned goal plus short-lived, strength-ranked notes so an
// agent sees the same locked objective on every turn and does not drift. It is
// deliberately tiny: no model calls, no embeddings, no external service. Rows
// live in the gateway SQLite database, scoped per project ("room").

export type MemoryTier =
  | "goal"
  | "step"
  | "semantic"
  | "procedural"
  | "assignment"

export type MemorySource = "user" | "tool" | "summary" | "subagent"

export interface MemoryEntry {
  id: string
  projectId: string
  sessionId: string
  tier: MemoryTier
  text: string
  hash: string
  count: number
  strength: number
  createdAt: number
  lastSeenAt: number
  pinned: boolean
  supersedes: string | null
  source: MemorySource
  /** Number of distinct sessions that produced this entry. */
  sessionCount: number
}

export interface MemoryProject {
  id: string
  name: string
  root: string
  remote: string
  createdAt: number
  updatedAt: number
}

export interface MemoryBlock {
  projectId: string
  sessionId: string
  goal: string | null
  previousGoal: string | null
  lines: Array<string>
  /** Ids of the entries that made it into the block (used for the boost). */
  usedIds: Array<string>
  text: string
  truncated: boolean
}

export interface MemoryBlockOptions {
  budget: number
  maxSteps: number
  maxKnowledge: number
}

export type MemoryObserveKind =
  | "user"
  | "tool"
  | "summary"
  | "subagent"
  | "goal"
  | "semantic"

export interface MemoryObserveInput {
  projectId: string
  sessionId: string
  kind: MemoryObserveKind
  text: string
  source?: MemorySource
  now?: number
}

export interface MemoryContextInput {
  projectId: string
  sessionId: string
  budget: number
  maxSteps: number
  maxKnowledge: number
}
