import { pgAvailable } from "~/lib/pg/client"

import { getStateConfig } from "./config"
import { PgStateStore } from "./store"

import type { StateRepository } from "./repository"

export { getStateConfig, defaultStateConfig } from "./config"
export type { StateConfig } from "./config"
export { MemoryStateRepository } from "./repository"
export type { StateRepository } from "./repository"
export type {
  Blueprint,
  BlueprintSearchInput,
  BootstrapPackage,
  StateEvent,
  StateEventInput,
  WorkingState,
  WorkingStateInput,
} from "./types"
export { buildBootstrapPackage } from "./bootstrap"
export { PROTOCOL_SNIPPET, stateToolDefinitions } from "./protocol"
export { resolveRepo, isValidRepoId } from "./repo"

let store: PgStateStore | null = null

/** Production repository (Postgres only; null when unavailable/disabled). */
export function getStateRepository(): StateRepository | null {
  if (!getStateConfig().enabled || !pgAvailable()) {
    return null
  }
  store ??= new PgStateStore()
  return store
}

export function resetStateStoreForTesting(): void {
  store = null
}
