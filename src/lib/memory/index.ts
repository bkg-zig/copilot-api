// Goal-anchored memory for the gateway.
//
// Agents use it directly over HTTP (see `src/routes/memory/route.ts`): they ask
// for the working block at the start of a turn and post what happened after.
// Storage is the gateway SQLite database, one set of rows per project.

export {
  DEFAULT_BUDGET,
  DEFAULT_MAX_KNOWLEDGE,
  DEFAULT_MAX_STEPS,
  FORGET_FLOOR,
  INITIAL_STRENGTH,
  MAX_STRENGTH,
  PROCEDURAL_THRESHOLD,
} from "./constants"
export { buildMemoryBlock } from "./block"
export { compactText, contentHash, normalizeText } from "./hash"
export {
  deriveProject,
  resolveProjectRef,
  type DerivedProject,
  type ResolvedProject,
} from "./projects"
export {
  MemoryStore,
  closeMemoryStore,
  getMemoryDbPath,
  getMemoryStore,
  resetMemoryStoreForTesting,
} from "./store"
export type {
  MemoryBlock,
  MemoryBlockOptions,
  MemoryContextInput,
  MemoryEntry,
  MemoryObserveInput,
  MemoryObserveKind,
  MemoryProject,
  MemorySource,
  MemoryTier,
} from "./types"
