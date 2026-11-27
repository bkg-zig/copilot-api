import { Hono } from "hono"
import { z } from "zod"

import {
  readEditableConfigFromDisk,
  writeConfigToDisk,
  SUPPORTED_PROVIDER_TYPES,
  type ProviderConfig,
  type ProviderType,
} from "~/lib/config/config-store"
import { isReservedProviderName } from "~/lib/config/provider-config"
import { forwardError } from "~/lib/http/error"
import { PATHS } from "~/lib/storage/paths"
import { resolveProviderConfig } from "~/lib/providers/provider-resolver"
import { reloadServerConfig } from "~/lib/config/config-reload"
import {
  filterHealthyProviderModels,
  getProviderModelHealthSnapshot,
  testProviderModel,
} from "~/lib/providers/model-health"
import { forwardProviderModels } from "~/services/providers/provider-proxy"

export const providerAdminRoutes = new Hono()

const SYSTEM_PROVIDER_NAMES = new Set([
  "copilot",
  "github-copilot",
  "codex",
  "xai",
  "bkg-api",
])

const providerTypeSchema = z.enum(SUPPORTED_PROVIDER_TYPES)
const authTypeSchema = z.enum([
  "none",
  "authorization",
  "azure-entra",
  "oauth2",
  "x-api-key",
  "x-goog-api-key",
])

const providerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/u,
    "Provider name may contain lowercase letters, numbers, dots, underscores and hyphens",
  )

const providerBaseSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value)
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:")
        && !parsed.username
        && !parsed.password
      )
    } catch {
      return false
    }
  }, "Provider URL must use HTTP(S) and must not embed credentials")

const createProviderSchema = z
  .object({
    name: providerNameSchema,
    type: providerTypeSchema,
    baseUrl: providerBaseSchema,
    apiKey: z.string().trim().optional(),
    authType: authTypeSchema.optional(),
    enabled: z.boolean().default(true),
    modelsDevProviderId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()

const updateProviderSchema = z
  .object({
    type: providerTypeSchema.optional(),
    baseUrl: providerBaseSchema.optional(),
    apiKey: z.string().trim().optional(),
    clearApiKey: z.boolean().optional(),
    authType: authTypeSchema.optional(),
    enabled: z.boolean().optional(),
    modelsDevProviderId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .nullable()
      .optional(),
  })
  .strict()

const modelIdSchema = z.string().trim().min(1).max(256)
const addManualModelSchema = z.object({ modelId: modelIdSchema }).strict()
const testModelSchema = z.object({ modelId: modelIdSchema }).strict()
const toggleModelSchema = z
  .object({
    modelId: modelIdSchema,
    enabled: z.boolean(),
  })
  .strict()

function defaultAuthType(type: ProviderType): ProviderConfig["authType"] {
  if (type === "anthropic") return "x-api-key"
  if (type === "google") return "x-goog-api-key"
  return "authorization"
}

function isSystemProvider(name: string): boolean {
  return SYSTEM_PROVIDER_NAMES.has(name)
}

function normalizeProviderBaseUrl(value: string, type: ProviderType): string {
  const url = new URL(value)
  url.hash = ""
  if (type !== "google") {
    const path = url.pathname.replace(/\/+$/u, "")
    if (/\/v1$/u.test(path)) {
      url.pathname = path.slice(0, -3) || "/"
    }
  }
  return url.toString().replace(/\/+$/u, "")
}

function safeProviderSummary(name: string, provider: ProviderConfig) {
  return {
    name,
    type: provider.type ?? "anthropic",
    baseUrl: provider.baseUrl ?? "",
    authType:
      provider.authType
      ?? defaultAuthType((provider.type ?? "anthropic") as ProviderType),
    enabled: provider.enabled !== false,
    hasApiKey: Boolean(provider.apiKey?.trim()),
    modelsDevProviderId: provider.modelsDevProviderId ?? "",
    agentsModels: provider.agentsModels ?? null,
    manualModels: provider.manualModels ?? [],
    disabledModels: provider.disabledModels ?? [],
    configuredModelMetadata: Object.keys(provider.models ?? {}),
    managed: isSystemProvider(name),
  }
}

function safeProviderList() {
  const config = readEditableConfigFromDisk()
  const providers = Object.entries(config.providers ?? {})
    .filter(
      ([name]) => !["copilot", "github-copilot", "codex", "xai"].includes(name),
    )
    .map(([name, provider]) => safeProviderSummary(name, provider))
  return {
    configPath: PATHS.CONFIG_PATH,
    providers,
  }
}

function writeProvider(name: string, provider: ProviderConfig): void {
  const config = readEditableConfigFromDisk()
  writeConfigToDisk({
    ...config,
    providers: {
      ...config.providers,
      [name]: provider,
    },
  })
}

async function applyProviderChanges(): Promise<void> {
  await reloadServerConfig()
}

async function getEnabledProviderOrNull(name: string) {
  return await resolveProviderConfig(name)
}

function parseProviderName(value: string): string {
  const parsed = providerNameSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid provider name")
  }
  return parsed.data
}

async function discoverProviderModels(name: string) {
  let provider = await getEnabledProviderOrNull(name)
  if (!provider)
    throw new Error(`Provider '${name}' is not configured or enabled`)
  if (
    !Array.isArray(provider.manualModels)
    || !Array.isArray(provider.disabledModels)
  ) {
    const config = readEditableConfigFromDisk()
    const existing = config.providers?.[name]
    if (!existing) throw new Error(`Provider '${name}' is not configured`)
    writeProvider(name, {
      ...existing,
      manualModels: existing.manualModels ?? [],
      disabledModels: existing.disabledModels ?? [],
    })
    await applyProviderChanges()
    provider = await getEnabledProviderOrNull(name)
    if (!provider)
      throw new Error(`Provider '${name}' is not configured or enabled`)
  }

  const response = await forwardProviderModels(
    provider,
    new Headers({
      "user-agent": "bkg-provider-admin/1.0",
    }),
  )
  if (!response.ok) {
    throw new Error(`Model discovery failed with HTTP ${response.status}`)
  }

  const body: unknown = await response.json().catch(() => null)
  if (
    !body
    || typeof body !== "object"
    || Array.isArray(body)
    || !("data" in body)
    || !Array.isArray(body.data)
  ) {
    throw new Error("Provider returned an unsupported model catalog response")
  }

  const discovered = body.data.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const id = (item as Record<string, unknown>).id
    return typeof id === "string" && id.trim() ? [id.trim()] : []
  })
  const manual = provider.manualModels ?? []
  const healthProvider = {
    ...provider,
    manualModels: manual,
    disabledModels: provider.disabledModels ?? [],
  }
  const ids = [...new Set([...discovered, ...manual])]
  const disabled = new Set(provider.disabledModels ?? [])

  const healthyRecords = await filterHealthyProviderModels(
    healthProvider,
    body.data.filter((item: unknown): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)),
    ),
  )
  const health = new Map(
    getProviderModelHealthSnapshot(healthProvider, ids).map((entry) => [
      entry.id,
      entry.health,
    ]),
  )

  return {
    provider: name,
    discoveredCount: discovered.length,
    healthyCount: healthyRecords.length,
    models: ids.map((id) => {
      const status = health.get(id)
      return {
        id,
        healthy: status?.healthy === true,
        tested: status !== null && status !== undefined,
        checkedAt: status?.checkedAt ?? null,
        reason: status?.reason ?? null,
        enabled: !disabled.has(id),
        manual: manual.includes(id) && !discovered.includes(id),
      }
    }),
  }
}

const FREE_PROVIDER_CATALOG_URL =
  "https://raw.githubusercontent.com/mvalentsev/awesome-free-ai-coding/main/index.json"
const FREE_PROVIDER_CATALOG_TTL_MS = 6 * 60 * 60 * 1000

type FreeCatalogRecord = Record<string, unknown>
type FreeCatalogCache = { expiresAt: number; payload: Record<string, unknown> }
let freeCatalogCache: FreeCatalogCache | null = null

export function resetFreeProviderCatalogCache(): void {
  freeCatalogCache = null
}

function isRecord(value: unknown): value is FreeCatalogRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function truncateText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : ""
}

function safeHttpsUrl(value: unknown, maxLength: number): string {
  const candidate = truncateText(value, maxLength)
  try {
    const url = new URL(candidate)
    if (
      url.protocol !== "https:"
      || !url.hostname
      || url.username
      || url.password
    )
      return ""
    return url.toString()
  } catch {
    return ""
  }
}

async function getFreeProviderCatalog(): Promise<Record<string, unknown>> {
  if (freeCatalogCache && freeCatalogCache.expiresAt > Date.now()) {
    return freeCatalogCache.payload
  }

  try {
    const response = await fetch(FREE_PROVIDER_CATALOG_URL, {
      headers: {
        accept: "application/json",
        "user-agent": "bkg-copi-provider-catalog/1.0",
      },
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) {
      throw new Error(`Catalog source returned HTTP ${response.status}`)
    }

    const source: unknown = await response.json()
    if (!isRecord(source) || !Array.isArray(source.entries)) {
      throw new Error("Catalog source returned an invalid document")
    }

    const providers = source.entries
      .flatMap((item: unknown) => {
        if (
          !isRecord(item)
          || item.archived === true
          || item.provisional === true
        )
          return []
        const api = isRecord(item.api) ? item.api : null
        if (!api || api.openai_compatible !== true) return []
        const baseUrl = truncateText(api.base_url, 500)
        if (!baseUrl) return []
        const auth = truncateText(api.auth, 40)
        const authType =
          auth === "none" ? "none"
          : auth === "x-api-key" || auth === "x-goog-api-key" ? auth
          : "authorization"
        const models =
          Array.isArray(api.model_ids) ?
            api.model_ids
              .filter(
                (model): model is string =>
                  typeof model === "string" && model.trim().length > 0,
              )
              .slice(0, 64)
          : []
        const dataUse = isRecord(item.data_use) ? item.data_use : null
        const sourceUrls =
          Array.isArray(item.source_urls) ?
            item.source_urls
              .map((url) => safeHttpsUrl(url, 500))
              .filter(Boolean)
              .slice(0, 8)
          : []
        return [
          {
            id: truncateText(item.id, 96),
            name: truncateText(item.name, 160),
            category: truncateText(item.category, 48),
            baseUrl,
            apiKeyUrl: safeHttpsUrl(api.key_url, 500),
            authType,
            modelIds: models,
            anthropicBaseUrl: truncateText(api.anthropic_base_url, 500),
            offering: truncateText(item.offering, 600),
            limits: truncateText(item.limits, 1800),
            note: truncateText(api.note, 1400),
            cardRequired: item.card_required === true,
            freePart: truncateText(item.free_part, 80),
            lastVerified: truncateText(item.last_verified, 32),
            dataUse:
              dataUse ?
                {
                  trains: truncateText(dataUse.trains, 24) || "unknown",
                  quote: truncateText(dataUse.quote, 1000),
                  url: safeHttpsUrl(dataUse.url, 500),
                }
              : { trains: "unknown", quote: "", url: "" },
            sourceUrls,
          },
        ]
      })
      .filter((provider) => provider.id && provider.name)

    const payload = {
      generated: truncateText(source.generated, 32),
      sourceUrl: FREE_PROVIDER_CATALOG_URL,
      siteUrl: safeHttpsUrl(source.site, 500),
      fetchedAt: new Date().toISOString(),
      providers,
    }
    freeCatalogCache = {
      expiresAt: Date.now() + FREE_PROVIDER_CATALOG_TTL_MS,
      payload,
    }
    return payload
  } catch (error) {
    if (freeCatalogCache) {
      return {
        ...freeCatalogCache.payload,
        stale: true,
        warning:
          "The catalogue source is unavailable; cached entries are shown.",
      }
    }
    throw error
  }
}

providerAdminRoutes.get("/catalog/free", async (c) => {
  try {
    return c.json(await getFreeProviderCatalog())
  } catch {
    return c.json(
      {
        error: {
          type: "upstream_error",
          message: "The free-provider catalogue is currently unavailable.",
        },
      },
      502,
    )
  }
})
providerAdminRoutes.get("/", (c) => {
  try {
    return c.json(safeProviderList())
  } catch (error) {
    return forwardError(c, error)
  }
})

providerAdminRoutes.post("/", async (c) => {
  try {
    const parsed = createProviderSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message:
              parsed.error.issues[0]?.message
              ?? "Invalid provider configuration",
          },
        },
        400,
      )
    }

    const input = parsed.data
    const name = parseProviderName(input.name)
    if (isSystemProvider(name) || isReservedProviderName(name)) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: `Provider name '${name}' is reserved`,
          },
        },
        400,
      )
    }

    const config = readEditableConfigFromDisk()
    if (Object.hasOwn(config.providers ?? {}, name)) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: `Provider '${name}' already exists`,
          },
        },
        409,
      )
    }

    const authType = input.authType ?? defaultAuthType(input.type)
    if (
      authType !== "none"
      && authType !== "azure-entra"
      && !input.apiKey?.trim()
    ) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "An API key is required for this authentication type",
          },
        },
        400,
      )
    }

    const provider: ProviderConfig = {
      type: input.type,
      baseUrl: normalizeProviderBaseUrl(input.baseUrl, input.type),
      authType,
      enabled: input.enabled,
      ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
      ...(input.modelsDevProviderId ?
        { modelsDevProviderId: input.modelsDevProviderId }
      : {}),
      manualModels: [],
      disabledModels: [],
    }
    writeProvider(name, provider)
    await applyProviderChanges()
    return c.json({ provider: safeProviderSummary(name, provider) }, 201)
  } catch (error) {
    return forwardError(c, error)
  }
})

providerAdminRoutes.patch("/:name", async (c) => {
  try {
    const name = parseProviderName(c.req.param("name"))
    if (isSystemProvider(name) || isReservedProviderName(name)) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: `Provider '${name}' is managed by the gateway`,
          },
        },
        403,
      )
    }

    const parsed = updateProviderSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message:
              parsed.error.issues[0]?.message ?? "Invalid provider update",
          },
        },
        400,
      )
    }

    const config = readEditableConfigFromDisk()
    const existing = config.providers?.[name]
    if (!existing)
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "Provider not found",
          },
        },
        404,
      )

    const update = parsed.data
    const next: ProviderConfig = {
      ...existing,
      manualModels: existing.manualModels ?? [],
      disabledModels: existing.disabledModels ?? [],
    }
    if (update.type !== undefined) next.type = update.type
    if (update.baseUrl !== undefined) {
      next.baseUrl = normalizeProviderBaseUrl(
        update.baseUrl,
        (update.type ?? next.type ?? "anthropic") as ProviderType,
      )
    }
    if (update.authType !== undefined) next.authType = update.authType
    if (update.enabled !== undefined) next.enabled = update.enabled
    if (update.modelsDevProviderId !== undefined) {
      if (update.modelsDevProviderId === null) delete next.modelsDevProviderId
      else next.modelsDevProviderId = update.modelsDevProviderId
    }
    if (update.clearApiKey === true) delete next.apiKey
    else if (update.apiKey?.trim()) next.apiKey = update.apiKey.trim()

    const authType =
      next.authType
      ?? defaultAuthType((next.type ?? "anthropic") as ProviderType)
    if (
      next.enabled !== false
      && authType !== "none"
      && authType !== "azure-entra"
      && !next.apiKey?.trim()
    ) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "An API key is required before enabling this provider",
          },
        },
        400,
      )
    }

    writeProvider(name, next)
    await applyProviderChanges()
    return c.json({ provider: safeProviderSummary(name, next) })
  } catch (error) {
    return forwardError(c, error)
  }
})

providerAdminRoutes.delete("/:name", async (c) => {
  try {
    const name = parseProviderName(c.req.param("name"))
    if (isSystemProvider(name) || isReservedProviderName(name)) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: `Provider '${name}' is managed by the gateway`,
          },
        },
        403,
      )
    }

    const config = readEditableConfigFromDisk()
    if (!Object.hasOwn(config.providers ?? {}, name)) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "Provider not found",
          },
        },
        404,
      )
    }
    const providers = { ...config.providers }
    delete providers[name]
    writeConfigToDisk({ ...config, providers })
    await applyProviderChanges()
    return c.json({ deleted: name })
  } catch (error) {
    return forwardError(c, error)
  }
})

providerAdminRoutes.post("/:name/models/discover", async (c) => {
  try {
    const name = parseProviderName(c.req.param("name"))
    return c.json(await discoverProviderModels(name))
  } catch (error) {
    return forwardError(c, error)
  }
})

providerAdminRoutes.post("/:name/models/test", async (c) => {
  try {
    const name = parseProviderName(c.req.param("name"))
    const parsed = testModelSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message:
              parsed.error.issues[0]?.message ?? "A model ID is required",
          },
        },
        400,
      )
    }
    const provider = await getEnabledProviderOrNull(name)
    if (!provider)
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "Provider not found or disabled",
          },
        },
        404,
      )
    const health = await testProviderModel(provider, parsed.data.modelId, {
      force: true,
    })
    return c.json({ modelId: parsed.data.modelId, ...health })
  } catch (error) {
    return forwardError(c, error)
  }
})

providerAdminRoutes.post("/:name/models/manual", async (c) => {
  try {
    const name = parseProviderName(c.req.param("name"))
    const parsed = addManualModelSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message:
              parsed.error.issues[0]?.message ?? "A model ID is required",
          },
        },
        400,
      )
    }
    const provider = await getEnabledProviderOrNull(name)
    if (!provider)
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "Provider not found or disabled",
          },
        },
        404,
      )
    const health = await testProviderModel(provider, parsed.data.modelId, {
      force: true,
    })
    if (!health.healthy) {
      return c.json(
        {
          error: {
            type: "model_unavailable",
            message:
              "The model did not return a non-empty completion; it was not added",
          },
          modelId: parsed.data.modelId,
          health,
        },
        422,
      )
    }

    const config = readEditableConfigFromDisk()
    const existing = config.providers?.[name]
    if (!existing)
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "Provider not found",
          },
        },
        404,
      )
    const disabledModels = (existing.disabledModels ?? []).filter(
      (id) => id !== parsed.data.modelId,
    )
    const manualModels = [
      ...new Set([...(existing.manualModels ?? []), parsed.data.modelId]),
    ]
    const next = { ...existing, manualModels, disabledModels }
    writeProvider(name, next)
    await applyProviderChanges()
    return c.json({ modelId: parsed.data.modelId, added: true, health })
  } catch (error) {
    return forwardError(c, error)
  }
})

providerAdminRoutes.post("/:name/models/toggle", async (c) => {
  try {
    const name = parseProviderName(c.req.param("name"))
    const parsed = toggleModelSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message:
              parsed.error.issues[0]?.message ?? "Invalid model selection",
          },
        },
        400,
      )
    }
    const config = readEditableConfigFromDisk()
    const existing = config.providers?.[name]
    if (!existing)
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "Provider not found",
          },
        },
        404,
      )
    const manualModels = existing.manualModels ?? []
    if (parsed.data.enabled && manualModels.includes(parsed.data.modelId)) {
      const provider = await getEnabledProviderOrNull(name)
      if (!provider)
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: "Provider not found or disabled",
            },
          },
          404,
        )
      const health = await testProviderModel(provider, parsed.data.modelId, {
        force: true,
      })
      if (!health.healthy) {
        return c.json(
          {
            error: {
              type: "model_unavailable",
              message:
                "The model failed its completion check and cannot be enabled",
            },
            modelId: parsed.data.modelId,
            health,
          },
          422,
        )
      }
    }
    const disabled = new Set(existing.disabledModels ?? [])
    if (parsed.data.enabled) disabled.delete(parsed.data.modelId)
    else disabled.add(parsed.data.modelId)
    const next = { ...existing, disabledModels: [...disabled] }
    writeProvider(name, next)
    await applyProviderChanges()
    return c.json({
      modelId: parsed.data.modelId,
      enabled: parsed.data.enabled,
    })
  } catch (error) {
    return forwardError(c, error)
  }
})
