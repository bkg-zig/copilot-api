import { getStateConfig } from "./config"

import type { Blueprint } from "./types"

/**
 * Optional embedding provider. Without a configured provider this returns
 * null and search falls back to Postgres FTS + tech_stack filtering.
 * A provider is configured via state.embeddingProvider/model.
 */
export type EmbeddingProvider = (
  texts: string[],
  config: { model: string; dimensions: number },
) => Promise<number[][] | null>

const providers = new Map<string, EmbeddingProvider>()

export function registerEmbeddingProvider(
  name: string,
  provider: EmbeddingProvider,
): void {
  providers.set(name, provider)
}

export function getEmbeddingProvider(name?: string): EmbeddingProvider | null {
  const config = getStateConfig()
  const key = (name || config.embeddingProvider || "").trim()
  if (!key) {
    return null
  }
  return providers.get(key) ?? null
}

export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  const config = getStateConfig()
  const provider = getEmbeddingProvider()
  if (!provider || texts.length === 0) {
    return null
  }
  try {
    const vectors = await provider(texts, {
      model: config.embeddingModel || "text-embedding-3-small",
      dimensions: config.embeddingDimensions,
    })
    if (!vectors || vectors.length !== texts.length) {
      return null
    }
    return vectors
  } catch {
    return null
  }
}

export function blueprintText(blueprint: Blueprint): string {
  return `${blueprint.title}\n${blueprint.problem}\n${blueprint.solution}`
}

export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`
}
