import { z } from "zod"

import {
  invalidateConfigCache,
  readEditableConfigFromDisk,
  writeConfigToDisk,
  type AppConfig,
  type ProviderApiKeyConfig,
  type ProviderConfig,
  type RouterConfig,
} from "./config-store"

const RESERVED_PROVIDER_NAMES = new Set(["copilot"])
const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

const providerApiKeySchema = z
  .object({
    key: z.string().trim().min(1, "API key cannot be empty."),
    enabled: z.boolean().optional(),
    rpm: z.number().positive().optional(),
    owner: z.string().trim().optional(),
  })
  .strict()

const providerInputSchema = z
  .object({
    name: z.string().trim().min(1, "Provider name is required."),
    type: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
    baseUrl: z.string().trim().optional(),
    apiKey: z.string().optional(),
    apiKeys: z.array(providerApiKeySchema).optional(),
    modelsDevProviderId: z.string().trim().optional(),
    authType: z.string().trim().optional(),
    accountId: z.string().trim().optional(),
    pricingCurrency: z.string().trim().optional(),
    agentsModels: z.array(z.string().trim().min(1)).nullable().optional(),
    includeModels: z.array(z.string().trim().min(1)).nullable().optional(),
    excludeModels: z.array(z.string().trim().min(1)).nullable().optional(),
    models: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    cookie: z.string().optional(),
  })
  .strict()

export type AdminProviderInput = z.infer<typeof providerInputSchema>

export interface AdminProviderApiKeyView {
  key: string
  enabled: boolean
  rpm: number | null
  owner: string
}

export interface AdminProviderView {
  name: string
  type: string
  enabled: boolean
  baseUrl: string
  modelsDevProviderId: string
  authType: string
  accountId: string
  hasApiKey: boolean
  apiKey: string
  apiKeys: Array<AdminProviderApiKeyView>
  cookie: string
  agentsModels: Array<string> | null
  includeModels: Array<string> | null
  excludeModels: Array<string> | null
  modelCount: number
}

function toView(name: string, provider: ProviderConfig): AdminProviderView {
  const apiKeys: Array<AdminProviderApiKeyView> = (
    Array.isArray(provider.apiKeys) ?
      provider.apiKeys
    : [])
    .filter((entry) => entry && typeof entry.key === "string")
    .map((entry) => ({
      key: entry.key,
      enabled: entry.enabled !== false,
      rpm:
        typeof entry.rpm === "number" && Number.isFinite(entry.rpm) ?
          entry.rpm
        : null,
      owner: entry.owner ?? "",
    }))
  return {
    name,
    type: provider.type ?? "anthropic",
    enabled: provider.enabled !== false,
    baseUrl: provider.baseUrl ?? "",
    modelsDevProviderId: provider.modelsDevProviderId ?? "",
    authType: provider.authType ?? "",
    accountId: provider.accountId ?? "",
    hasApiKey:
      (typeof provider.apiKey === "string" && provider.apiKey.length > 0)
      || apiKeys.some((entry) => entry.enabled),
    apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "",
    apiKeys,
    cookie: typeof provider.cookie === "string" ? provider.cookie : "",
    agentsModels:
      Array.isArray(provider.agentsModels) ? [...provider.agentsModels] : null,
    includeModels:
      Array.isArray(provider.includeModels) ?
        [...provider.includeModels]
      : null,
    excludeModels:
      Array.isArray(provider.excludeModels) ?
        [...provider.excludeModels]
      : null,
    modelCount:
      Object.keys(provider.models ?? {}).length
      + (provider.agentsModels?.length ?? 0),
  }
}

export function getAdminProviders(): Array<AdminProviderView> {
  const config = readEditableConfigFromDisk()
  return Object.entries(config.providers ?? {})
    .filter(([name]) => !RESERVED_PROVIDER_NAMES.has(name))
    .map(([name, provider]) => toView(name, provider))
}

export function getAdminProviderModels(
  name: string,
): Array<{ id: string; [key: string]: unknown }> {
  const config = readEditableConfigFromDisk()
  const provider = config.providers?.[name]
  if (!provider) {
    throw new Error(`Provider '${name}' not found.`)
  }
  const modelEntries =
    provider.models ?
      Object.entries(provider.models).map(([id, model]) => ({
        id,
        ...(model as Record<string, unknown>),
      }))
    : []
  if (modelEntries.length > 0) {
    return modelEntries
  }
  const agentModels =
    Array.isArray(provider.agentsModels) ?
      provider.agentsModels.filter(
        (agentModel) =>
          typeof agentModel === "string" && agentModel.trim().length > 0,
      )
    : []
  return agentModels.map((agentModel) => ({ id: agentModel, agentModel }))
}

export function upsertAdminProvider(input: unknown): Array<AdminProviderView> {
  const parsed = providerInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid provider.")
  }
  const data = parsed.data
  const name = data.name
  if (RESERVED_PROVIDER_NAMES.has(name)) {
    throw new Error(`Provider name '${name}' is reserved.`)
  }
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    throw new Error(
      "Provider name may only contain letters, numbers, dot, dash and underscore.",
    )
  }

  const config = readEditableConfigFromDisk()
  const providers = { ...config.providers }
  const existing = providers[name] ?? {}
  const next: ProviderConfig = { ...existing }

  if (data.type !== undefined) next.type = data.type
  if (data.enabled !== undefined) next.enabled = data.enabled
  if (data.baseUrl !== undefined) {
    if (data.baseUrl) next.baseUrl = data.baseUrl
    else delete next.baseUrl
  }
  if (data.apiKey !== undefined) {
    if (data.apiKey.trim()) next.apiKey = data.apiKey.trim()
    else delete next.apiKey
  }
  if (data.apiKeys !== undefined) {
    const keys: Array<ProviderApiKeyConfig> = []
    const seen = new Set<string>()
    for (const entry of data.apiKeys) {
      const key = entry.key.trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      keys.push({
        key,
        ...(entry.enabled === false ? { enabled: false } : {}),
        ...(entry.rpm !== undefined ? { rpm: entry.rpm } : {}),
        ...(entry.owner ? { owner: entry.owner } : {}),
      })
    }
    if (keys.length > 0) next.apiKeys = keys
    else delete next.apiKeys
  }
  if (data.modelsDevProviderId !== undefined) {
    if (data.modelsDevProviderId)
      next.modelsDevProviderId = data.modelsDevProviderId
    else delete next.modelsDevProviderId
  }
  if (data.authType !== undefined) {
    if (data.authType)
      next.authType = data.authType as ProviderConfig["authType"]
    else delete next.authType
  }
  if (data.accountId !== undefined) {
    if (data.accountId) next.accountId = data.accountId
    else delete next.accountId
  }
  if (data.pricingCurrency !== undefined) {
    if (data.pricingCurrency) next.pricingCurrency = data.pricingCurrency
    else delete next.pricingCurrency
  }
  if (data.cookie !== undefined) {
    if (data.cookie.trim()) next.cookie = data.cookie.trim()
    else delete next.cookie
  }
  if (data.agentsModels === null) {
    delete next.agentsModels
  } else if (data.agentsModels !== undefined) {
    next.agentsModels = [...new Set(data.agentsModels)]
  }
  if (data.includeModels === null) {
    delete next.includeModels
  } else if (data.includeModels !== undefined) {
    next.includeModels = [...new Set(data.includeModels)]
  }
  if (data.excludeModels === null) {
    delete next.excludeModels
  } else if (data.excludeModels !== undefined) {
    next.excludeModels = [...new Set(data.excludeModels)]
  }
  if (data.models !== undefined) {
    next.models = data.models as ProviderConfig["models"]
  }

  providers[name] = next
  const updated: AppConfig = { ...config, providers }
  writeConfigToDisk(updated)
  invalidateConfigCache()
  return getAdminProviders()
}

export function deleteAdminProvider(name: string): Array<AdminProviderView> {
  if (RESERVED_PROVIDER_NAMES.has(name)) {
    throw new Error(`Provider '${name}' cannot be removed.`)
  }
  const config = readEditableConfigFromDisk()
  if (!config.providers || !Object.hasOwn(config.providers, name)) {
    throw new Error(`Provider '${name}' is not configured.`)
  }
  const providers = { ...config.providers }
  delete providers[name]
  const updated: AppConfig = { ...config, providers }
  writeConfigToDisk(updated)
  invalidateConfigCache()
  return getAdminProviders()
}

export interface AdminKeysView {
  apiKeys: Array<string>
  adminApiKey: string
}

export function getAdminKeys(): AdminKeysView {
  const config = readEditableConfigFromDisk()
  return {
    apiKeys:
      Array.isArray(config.auth?.apiKeys) ? [...config.auth.apiKeys] : [],
    adminApiKey: config.auth?.adminApiKey ?? "",
  }
}

export function setAdminKeys(input: unknown): AdminKeysView {
  const schema = z
    .object({
      apiKeys: z.array(z.string()).optional(),
      adminApiKey: z.string().optional(),
    })
    .strict()
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid keys.")
  }

  const config = readEditableConfigFromDisk()
  const auth = { ...config.auth }

  if (parsed.data.apiKeys !== undefined) {
    const normalized = [
      ...new Set(
        parsed.data.apiKeys
          .map((key) => key.trim())
          .filter((key) => key.length > 0),
      ),
    ]
    auth.apiKeys = normalized
  }

  if (parsed.data.adminApiKey !== undefined) {
    const adminApiKey = parsed.data.adminApiKey.trim()
    if (!adminApiKey) {
      throw new Error("The admin API key cannot be empty.")
    }
    auth.adminApiKey = adminApiKey
  }

  writeConfigToDisk({ ...config, auth })
  invalidateConfigCache()
  return getAdminKeys()
}

export function getAdminRouter(): RouterConfig {
  const config = readEditableConfigFromDisk()
  return config.router ?? {}
}

const routerRuleSchema = z
  .object({
    match: z.string().min(1, "Rule pattern is required."),
    model: z.string().trim().min(1, "Rule model is required."),
    flags: z.string().optional(),
  })
  .strict()

const routerInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    alias: z.string().trim().min(1).optional(),
    pool: z.array(z.string().trim().min(1)).optional(),
    strategy: z.enum(["auto", "rules", "heuristic"]).optional(),
    rules: z.array(routerRuleSchema).optional(),
    defaultModel: z.string().trim().optional(),
    modelHints: z
      .record(
        z.string(),
        z
          .object({
            power: z.number().min(0).max(100).optional(),
            vision: z.boolean().optional(),
            code: z.boolean().optional(),
            reasoning: z.boolean().optional(),
            safety: z.boolean().optional(),
            cost: z.number().min(0).max(100).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

export function setAdminRouter(input: unknown): RouterConfig {
  const parsed = routerInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid router config.")
  }
  for (const rule of parsed.data.rules ?? []) {
    try {
      new RegExp(rule.match, rule.flags ?? "i")
    } catch {
      throw new Error(`Invalid rule pattern: ${rule.match}`)
    }
  }
  const config = readEditableConfigFromDisk()
  writeConfigToDisk({ ...config, router: parsed.data })
  invalidateConfigCache()
  return getAdminRouter()
}
