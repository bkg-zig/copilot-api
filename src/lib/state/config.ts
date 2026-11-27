import { getConfig } from "~/lib/config"

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
  let raw: AppStateConfig = {}
  try {
    raw = getConfig().state ?? {}
  } catch {
    raw = {}
  }
  return {
    enabled: raw.enabled ?? defaultStateConfig.enabled,
    autoMigrate: raw.autoMigrate ?? defaultStateConfig.autoMigrate,
    extractorModel: raw.extractorModel ?? defaultStateConfig.extractorModel,
    allowMeteredExtraction:
      raw.allowMeteredExtraction ?? defaultStateConfig.allowMeteredExtraction,
    embeddingProvider:
      raw.embeddingProvider ?? defaultStateConfig.embeddingProvider,
    embeddingModel: raw.embeddingModel ?? defaultStateConfig.embeddingModel,
    embeddingDimensions:
      raw.embeddingDimensions ?? defaultStateConfig.embeddingDimensions,
    blueprintSearchLimit:
      raw.blueprintSearchLimit ?? defaultStateConfig.blueprintSearchLimit,
    injection: {
      enabled: raw.injection?.enabled ?? defaultStateConfig.injection.enabled,
      includeBlueprint:
        raw.injection?.includeBlueprint
        ?? defaultStateConfig.injection.includeBlueprint,
    },
    constraints: raw.constraints ?? {},
  }
}

type AppStateConfig = NonNullable<ReturnType<typeof getConfig>["state"]>
