import { Hono, type Context } from "hono"

import { getConfig } from "~/lib/config"
import {
  generateGatewayApiKey,
  generateGatewayApiKeyId,
  maskApiKey,
  normalizeApiKeyRecord,
  normalizeApiKeyRecords,
} from "~/lib/api-key-config"
import {
  removeConfiguredApiKey,
  upsertConfiguredApiKey,
} from "~/lib/config-store"
import {
  getApiKeyQuotaUsage,
  getTokenUsageSummary,
} from "~/lib/token-usage/store"
import type { GatewayApiKeyConfig } from "~/lib/types/api-key"

/**
 * Admin-only management of gateway client keys: list them with their token
 * usage, create new keys (optionally bound to a model allowlist and quota),
 * update them, or delete them. Mounted under `/admin/api-keys`, which is
 * guarded by the admin API key / admin session middleware in `server.ts`.
 */
export const apiKeyManagementRoutes = new Hono()

interface ApiKeyUsageView {
  usedAmount: number
  remainingAmount: number | null
  resetsAt: number | null
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  requestCount: number
}

async function usageFor(key: GatewayApiKeyConfig): Promise<ApiKeyUsageView> {
  const quota = await getApiKeyQuotaUsage(key).catch(() => ({
    usedAmount: 0,
    remainingAmount: null,
    resetsAt: null,
  }))
  const summary = await getTokenUsageSummary("lifetime", key.id).catch(
    () => null,
  )
  return {
    usedAmount: quota.usedAmount,
    remainingAmount: quota.remainingAmount,
    resetsAt: quota.resetsAt,
    totalTokens: summary?.totals.total_tokens ?? 0,
    inputTokens: summary?.totals.input_tokens ?? 0,
    outputTokens: summary?.totals.output_tokens ?? 0,
    cacheReadInputTokens: summary?.totals.cache_read_input_tokens ?? 0,
    requestCount: summary?.totals.request_count ?? 0,
  }
}

function keyView(key: GatewayApiKeyConfig, usage: ApiKeyUsageView) {
  return {
    id: key.id,
    name: key.name ?? null,
    key: key.key,
    maskedKey: maskApiKey(key.key),
    enabled: key.enabled !== false,
    expiresAt: key.expiresAt ?? null,
    allowedModels: key.allowedModels ?? null,
    quota: key.quota ?? null,
    usage,
  }
}

function errorResponse(c: Context, error: unknown, status: 400 | 404) {
  const message =
    error instanceof Error ? error.message : "Invalid API key request."
  return c.json(
    {
      error: {
        message,
        type: status === 404 ? "not_found_error" : "invalid_request_error",
      },
    },
    status,
  )
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json()
    return body && typeof body === "object" ?
        (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function configuredKeys(): Array<GatewayApiKeyConfig> {
  return normalizeApiKeyRecords(getConfig().auth?.apiKeyConfigs)
}

apiKeyManagementRoutes.get("/", async (c) => {
  const keys = configuredKeys()
  const items = await Promise.all(
    keys.map(async (key) => keyView(key, await usageFor(key))),
  )
  return c.json({ keys: items })
})

apiKeyManagementRoutes.post("/", async (c) => {
  const body = await readJson(c)
  const id =
    typeof body.id === "string" && body.id.trim() ?
      body.id.trim()
    : generateGatewayApiKeyId()
  const key =
    typeof body.key === "string" && body.key.trim() ?
      body.key.trim()
    : generateGatewayApiKey()
  const input: Record<string, unknown> = { id, key }
  if (typeof body.name === "string" && body.name.trim())
    input.name = body.name.trim()
  if (typeof body.enabled === "boolean") input.enabled = body.enabled
  if (typeof body.expiresAt === "string" && body.expiresAt.trim())
    input.expiresAt = body.expiresAt.trim()
  if (Array.isArray(body.allowedModels))
    input.allowedModels = body.allowedModels
  if (body.quota && typeof body.quota === "object") input.quota = body.quota

  try {
    const saved = upsertConfiguredApiKey(normalizeApiKeyRecord(input))
    return c.json({ key: keyView(saved, await usageFor(saved)) }, 201)
  } catch (error) {
    return errorResponse(c, error, 400)
  }
})

apiKeyManagementRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id")
  const existing = configuredKeys().find((entry) => entry.id === id)
  if (!existing) {
    return errorResponse(c, new Error(`API key '${id}' not found.`), 404)
  }
  const body = await readJson(c)
  const input: Record<string, unknown> = { id, key: existing.key }
  if (body.regenerateKey === true) input.key = generateGatewayApiKey()
  else if (typeof body.key === "string" && body.key.trim())
    input.key = body.key.trim()
  // Absent or null clears the field; normalizeApiKeyRecord only keeps values
  // that are explicitly present.
  if (typeof body.name === "string" && body.name.trim())
    input.name = body.name.trim()
  if (typeof body.enabled === "boolean") input.enabled = body.enabled
  if (typeof body.expiresAt === "string" && body.expiresAt.trim())
    input.expiresAt = body.expiresAt.trim()
  if (Array.isArray(body.allowedModels))
    input.allowedModels = body.allowedModels
  if (body.quota && typeof body.quota === "object") input.quota = body.quota

  try {
    const saved = upsertConfiguredApiKey(normalizeApiKeyRecord(input))
    return c.json({ key: keyView(saved, await usageFor(saved)) })
  } catch (error) {
    return errorResponse(c, error, 400)
  }
})

apiKeyManagementRoutes.delete("/:id", (c) => {
  const id = c.req.param("id")
  if (!configuredKeys().some((entry) => entry.id === id)) {
    return errorResponse(c, new Error(`API key '${id}' not found.`), 404)
  }
  removeConfiguredApiKey(id)
  return c.json({ ok: true })
})
