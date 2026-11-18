import consola from "consola"

import {
  SUPPORTED_PROVIDER_TYPES,
  getConfig,
  readEditableConfigFromDisk,
  reloadConfig,
  writeConfigToDisk,
  type ModelConfig,
  type ProviderAuthType,
  type ProviderConfig,
  type ProviderType,
} from "./config-store"
import {
  getModelsDevModelApi,
  getModelsDevModelPricing,
  getModelsDevModelProviderType,
  getModelsDevProviderApi,
  getOpencodeGoModelProviderType,
} from "./models-dev-cache"
import {
  resolveProviderModelsDevId,
  usesModelsDevModelCatalog,
} from "./provider-model-catalog"

export interface ResolvedProviderApiKey {
  key: string
  rpm?: number
}

export interface ResolvedProviderConfig {
  name: string
  type: ProviderType
  baseUrl: string
  modelsDevProviderId?: string
  apiKey: string
  /**
   * Enabled keys for rotation. Always contains at least one entry when the
   * provider authenticates with a key; `apiKey` mirrors the first entry for
   * the single-key paths. Undefined for auth types without a key.
   */
  keyPool?: Array<ResolvedProviderApiKey>
  authType: ProviderAuthType
  authTypeExplicit?: boolean
  pricingCurrency?: string
  models?: Record<string, ModelConfig>
  agentsModels?: Array<string>
  /** Glob patterns of upstream model ids to keep (only matching ids listed). */
  includeModels?: Array<string>
  /** Glob patterns of upstream model ids to hide. */
  excludeModels?: Array<string>
  cookie?: string
  webAdapter?: string
}

export function normalizeProviderBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/u, "")
    .replace(
      /^https:\/\/opencode\.ai\/zen\/go(?=\/|$)/u,
      "https://opencode.ai/inference/go",
    )
}

export function isSupportedProviderType(value: string): value is ProviderType {
  return SUPPORTED_PROVIDER_TYPES.includes(value as ProviderType)
}

function getDefaultProviderAuthType(
  providerType: ProviderType,
): ProviderAuthType {
  if (providerType === "google") return "x-goog-api-key"
  if (providerType === "chatgpt" || providerType === "web") return "cookie"
  return providerType === "anthropic" ? "x-api-key" : "authorization"
}

export function resolveProviderAuthType(
  providerName: string,
  authType: string | undefined,
  providerType: ProviderType,
): ProviderAuthType {
  const defaultAuthType = getDefaultProviderAuthType(providerType)
  if (authType === undefined) {
    return defaultAuthType
  }

  if (authType === "x-api-key" || authType === "x-goog-api-key") {
    return authType
  }

  if (authType === "oauth2") {
    if (
      providerName === "codex"
      || providerName === "xai"
      || providerName === "anthropic"
    ) {
      return authType
    }

    consola.warn(
      `Provider ${providerName} has authType 'oauth2', which is only supported by the builtin codex, xai and anthropic providers, falling back to ${defaultAuthType}`,
    )
    return defaultAuthType
  }

  if (authType === "authorization" || authType === "azure-entra") {
    return authType
  }

  if (authType === "cookie") {
    if (providerType === "chatgpt" || providerType === "web") {
      return authType
    }

    consola.warn(
      `Provider ${providerName} has authType 'cookie', which is only supported by chatgpt and web providers, falling back to ${defaultAuthType}`,
    )
    return defaultAuthType
  }

  consola.warn(
    `Provider ${providerName} has invalid authType '${authType}', falling back to ${defaultAuthType}`,
  )
  return defaultAuthType
}

/**
 * Normalizes the single `apiKey` shorthand and the `apiKeys` pool into one
 * deduplicated list of enabled keys. Entries may be objects or bare strings so
 * hand-written config files stay valid.
 */
export function resolveProviderApiKeyPool(
  provider: ProviderConfig,
): Array<ResolvedProviderApiKey> {
  const entries: Array<unknown> = [
    ...(Array.isArray(provider.apiKeys) ? provider.apiKeys : []),
    provider.apiKey,
  ]
  const pool: Array<ResolvedProviderApiKey> = []
  const seen = new Set<string>()

  for (const entry of entries) {
    const record =
      typeof entry === "string" ? { key: entry }
      : entry && typeof entry === "object" ?
        (entry as { key?: unknown; rpm?: unknown; enabled?: unknown })
      : null
    if (!record || record.enabled === false) continue
    if (typeof record.key !== "string") continue

    const key = record.key.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)

    const rpm =
      (
        typeof record.rpm === "number"
        && Number.isFinite(record.rpm)
        && record.rpm > 0
      ) ?
        Math.floor(record.rpm)
      : undefined
    pool.push(rpm === undefined ? { key } : { key, rpm })
  }

  return pool
}

function isProviderApiKeyRequired(
  providerName: string,
  authType: ProviderAuthType,
): boolean {
  return (
    authType !== "azure-entra"
    && authType !== "cookie"
    && !(
      (providerName === "codex" || providerName === "xai")
      && authType === "oauth2"
    )
    && !(providerName === "anthropic" && authType === "oauth2")
  )
}

export function getRawProviderConfig(name: string): ProviderConfig | null {
  const providerName = name.trim()
  if (!providerName) {
    return null
  }

  const config = getConfig()
  return config.providers?.[providerName] ?? null
}

export function setProviderConfig(
  name: string,
  provider: ProviderConfig,
): ProviderConfig {
  const providerName = name.trim()
  if (!providerName) {
    throw new Error("Provider name must be a non-empty string")
  }

  if (isReservedProviderName(providerName)) {
    throw new Error(
      `Provider ${providerName} is reserved and cannot be configured in config.providers`,
    )
  }

  const editableConfig = readEditableConfigFromDisk()
  const nextConfig = {
    ...editableConfig,
    providers: {
      ...editableConfig.providers,
      [providerName]: provider,
    },
  }

  writeConfigToDisk(nextConfig)
  reloadConfig()
  return getRawProviderConfig(providerName) ?? provider
}

/**
 * Validates and normalizes one raw provider entry. Pure with respect to the
 * config store so it can be tested without touching global config state; the
 * caller is responsible for resolving `provider` from a name.
 */
export function resolveProviderConfigFromProvider(
  providerName: string,
  provider: ProviderConfig,
): ResolvedProviderConfig | null {
  if (provider.enabled === false) {
    return null
  }

  const type = provider.type ?? "anthropic"
  if (!isSupportedProviderType(type)) {
    consola.warn(
      `Provider ${providerName} is ignored because type '${type}' is not supported`,
    )
    return null
  }

  const defaultChatGPTBaseUrl = "https://chatgpt.com/backend-api"
  const baseUrl = normalizeProviderBaseUrl(
    type === "chatgpt" && !provider.baseUrl ? defaultChatGPTBaseUrl
    : (
      type === "anthropic" && providerName === "anthropic" && !provider.baseUrl
    ) ?
      "https://api.anthropic.com"
    : (provider.baseUrl ?? ""),
  )
  const authType = resolveProviderAuthType(
    providerName,
    provider.authType,
    type,
  )
  const keyPool = resolveProviderApiKeyPool(provider)
  const apiKey = keyPool[0]?.key ?? ""
  const missingFields = [
    ...(baseUrl || type === "web" ? [] : ["baseUrl"]),
    ...(isProviderApiKeyRequired(providerName, authType) && !apiKey ?
      ["apiKey"]
    : []),
  ]

  if (missingFields.length > 0) {
    consola.warn(
      `Provider ${providerName} is enabled but missing ${missingFields.join(" or ")}`,
    )
    return null
  }

  return {
    name: providerName,
    type,
    baseUrl,
    modelsDevProviderId: provider.modelsDevProviderId,
    apiKey,
    keyPool: keyPool.length > 1 ? keyPool : undefined,
    authType,
    authTypeExplicit: provider.authType !== undefined,
    pricingCurrency: normalizePricingCurrency(provider.pricingCurrency),
    models: provider.models,
    agentsModels: provider.agentsModels,
    includeModels: provider.includeModels,
    excludeModels: provider.excludeModels,
    cookie: provider.cookie?.trim(),
    webAdapter: provider.webAdapter?.trim() || undefined,
  }
}

export function getProviderConfig(name: string): ResolvedProviderConfig | null {
  const providerName = name.trim()
  if (!providerName) {
    return null
  }

  if (isReservedProviderName(providerName)) {
    consola.warn(
      `Provider ${providerName} is reserved and cannot be configured in config.providers`,
    )
    return null
  }

  const provider = getRawProviderConfig(providerName)
  if (!provider) {
    return null
  }

  return resolveProviderConfigFromProvider(providerName, provider)
}

export function resolveEffectiveProviderType(
  providerConfig: ResolvedProviderConfig,
  model: string,
): ProviderType {
  const modelConfig = providerConfig.models?.[model]
  if (modelConfig?.type && isSupportedProviderType(modelConfig.type)) {
    return modelConfig.type
  }

  if (providerConfig.name === "opencode-go") {
    return getOpencodeGoModelProviderType(model)
  }

  if (providerConfig.modelsDevProviderId) {
    const catalogType = getModelsDevModelProviderType(
      providerConfig.modelsDevProviderId,
      model,
    )
    if (catalogType) return catalogType
  }

  if (providerConfig.name === "openrouter") {
    if (model.includes("gpt-")) {
      return "openai-responses"
    }
  }

  return providerConfig.type
}

export function resolveProviderConfigForModel(
  providerConfig: ResolvedProviderConfig,
  model: string,
): ResolvedProviderConfig {
  const type = resolveEffectiveProviderType(providerConfig, model)
  const modelApi =
    (
      providerConfig.modelsDevProviderId
      && providerConfig.baseUrl
        === getModelsDevProviderApi(providerConfig.modelsDevProviderId)
    ) ?
      getModelsDevModelApi(providerConfig.modelsDevProviderId, model)
    : undefined
  const configuredModel = providerConfig.models?.[model]
  const catalogPricing =
    (
      providerConfig.modelsDevProviderId
      || usesModelsDevModelCatalog(providerConfig.name)
    ) ?
      getModelsDevModelPricing(
        resolveProviderModelsDevId(providerConfig.name, providerConfig),
        model,
      )
    : undefined
  const useCatalogPricing =
    catalogPricing !== undefined && configuredModel?.pricing === undefined
  if (type === providerConfig.type && !modelApi && !useCatalogPricing) {
    return providerConfig
  }

  return {
    ...providerConfig,
    type,
    baseUrl: modelApi ?? providerConfig.baseUrl,
    models:
      useCatalogPricing ?
        {
          ...providerConfig.models,
          [model]: { ...configuredModel, pricing: catalogPricing },
        }
      : providerConfig.models,
    pricingCurrency: useCatalogPricing ? "USD" : providerConfig.pricingCurrency,
    authType:
      (
        type !== providerConfig.type
        && !providerConfig.authTypeExplicit
        && providerConfig.authType !== "azure-entra"
        && providerConfig.authType !== "oauth2"
      ) ?
        resolveProviderAuthType(providerConfig.name, undefined, type)
      : providerConfig.authType,
  }
}

function normalizePricingCurrency(
  value: string | undefined,
): string | undefined {
  const currency = value?.trim().toUpperCase()
  return currency || undefined
}

export function listEnabledProviders(): Array<string> {
  const config = getConfig()
  const providerNames = Object.keys(config.providers ?? {})
  return providerNames.filter(
    (name) => !isReservedProviderName(name) && getProviderConfig(name) !== null,
  )
}

export function isReservedProviderName(name: string): boolean {
  return name.trim() === "copilot" || name.trim() === "github-copilot"
}
