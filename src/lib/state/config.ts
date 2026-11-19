import { getConfig } from "~/lib/config-store"

export interface StateConfig {
  enabled: boolean
  autoMigrate: boolean
  extractorModel: string
  allowMeteredExtraction: boolean
  embeddingProvider: string
  embeddingModel: string
  embeddingDimensions: number
  blueprintSearchLimit: number
  injection: { enabled: boolean; includeBlueprint: boolean }
  constraints: Record<string, string[]>
}

export const defaultStateConfig: StateConfig = {
  enabled: true,
  autoMigrate: true,
  extractorModel: "",
  allowMeteredExtraction: false,
  embeddingProvider: "",
  embeddingModel: "",
  embeddingDimensions: 1536,
  blueprintSearchLimit: 5,
  injection: { enabled: true, includeBlueprint: true },
  constraints: {},
}

/** Merged state config (never force-persists; read fresh each call). */
export function getStateConfig(): StateConfig {
  let raw: Partial<StateConfig> = {}
  try {
    raw = getConfig().state ?? {}
  } catch {
    raw = {}
  }
  return {
    ...defaultStateConfig,
    ...raw,
    injection: { ...defaultStateConfig.injection, ...(raw.injection ?? {}) },
    constraints: raw.constraints ?? {},
  }
}
