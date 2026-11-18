import type { ProviderConfig } from "./config-store"
import { builtinProviderModelRegistry } from "./builtin-provider-models"
import {
  getModelsDevModelConfig,
  getModelsDevProviderModelRecords,
  getOpencodeGoModelRecords,
  isModelsDevModelVisible,
} from "./models-dev-cache"

const CATALOG_PROVIDERS = new Set([
  "xai",
  "openrouter",
  "deepseek",
  "kimi",
  "dashscope",
])
const CATALOG_ALIASES: Record<
  string,
  { id: string; hosts: Record<string, string> }
> = {
  kimi: {
    id: "kimi-code-plan-cn",
    hosts: {
      "api.kimi.ai": "kimi-code-plan-global",
      "api.moonshot.ai": "moonshotai",
      "api.moonshot.cn": "moonshotai-cn",
    },
  },
  dashscope: {
    id: "alibaba-cn",
    hosts: {
      "dashscope-intl.aliyuncs.com": "alibaba",
      "coding.dashscope.aliyuncs.com": "alibaba-coding-plan-cn",
      "coding-intl.dashscope.aliyuncs.com": "alibaba-coding-plan",
      "token-plan.cn-beijing.maas.aliyuncs.com": "alibaba-token-plan-cn",
      "token-plan.ap-southeast-1.maas.aliyuncs.com": "alibaba-token-plan",
    },
  },
}

export function usesModelsDevModelCatalog(provider: string): boolean {
  return CATALOG_PROVIDERS.has(provider)
}

type CatalogProviderConfig = Pick<
  ProviderConfig,
  "baseUrl" | "modelsDevProviderId" | "includeModels" | "excludeModels"
>

/**
 * Minimal glob matcher for model id filters: `*` matches any run of characters
 * and `?` matches a single character. Everything else is literal, so ids with
 * `/`, `.` and `-` need no escaping.
 */
export function matchesModelGlob(pattern: string, modelId: string): boolean {
  const trimmed = pattern.trim()
  if (!trimmed) return false
  let regex = "^"
  for (const char of trimmed) {
    if (char === "*") regex += ".*"
    else if (char === "?") regex += "."
    else regex += char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  }
  regex += "$"
  return new RegExp(regex, "u").test(modelId)
}

function matchesProviderModelFilter(
  modelId: string,
  config?: CatalogProviderConfig | null,
): boolean {
  const include = config?.includeModels
  if (
    Array.isArray(include)
    && include.length > 0
    && !include.some((pattern) => matchesModelGlob(pattern, modelId))
  ) {
    return false
  }
  const exclude = config?.excludeModels
  if (
    Array.isArray(exclude)
    && exclude.some((pattern) => matchesModelGlob(pattern, modelId))
  ) {
    return false
  }
  return true
}

export function resolveProviderModelsDevId(
  provider: string,
  config?: CatalogProviderConfig | null,
): string {
  if (config?.modelsDevProviderId) return config.modelsDevProviderId
  const alias = CATALOG_ALIASES[provider]
  if (!alias) return provider

  const baseUrl = config?.baseUrl
  if (baseUrl) {
    try {
      return alias.hosts[new URL(baseUrl).hostname] ?? alias.id
    } catch {
      // Custom proxies and invalid URLs use the provider's default catalog.
    }
  }
  return alias.id
}

export function isProviderModelVisible(
  provider: string,
  modelId: string,
  config?: CatalogProviderConfig | null,
): boolean {
  if (!matchesProviderModelFilter(modelId, config)) {
    return false
  }
  return isModelsDevModelVisible(
    resolveProviderModelsDevId(provider, config),
    modelId,
  )
}

export function getLocalProviderModelRecords(
  provider: string,
  config?: CatalogProviderConfig | null,
): Array<Record<string, unknown>> | undefined {
  if (provider === "opencode-go") return getOpencodeGoModelRecords()
  if (!config?.modelsDevProviderId && !usesModelsDevModelCatalog(provider)) {
    return undefined
  }
  return getModelsDevProviderModelRecords(
    resolveProviderModelsDevId(provider, config),
  )
}

export function getProviderModelConfig(
  provider: string,
  model: string,
  config?: CatalogProviderConfig | null,
) {
  return (
    getModelsDevModelConfig(resolveProviderModelsDevId(provider, config), model)
    ?? builtinProviderModelRegistry.getModelConfig(provider, model)
  )
}
