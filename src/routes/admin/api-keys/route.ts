import consola from "consola"
import { Hono, type Context } from "hono"

import {
  GatewayApiKeyStore,
  GatewayApiKeyStoreError,
  generateGatewayApiKey,
  gatewayApiKeyStore,
  type GatewayApiKeyCreateInput,
  type GatewayApiKeyUpdateInput,
} from "~/lib/auth/gateway-api-keys"
import { getApiKeyQuotaUsage } from "~/lib/auth/api-key-quota-runtime"
import { getConfig } from "~/lib/config"
import { normalizeApiKeyRecords } from "~/lib/config/api-key-config"
import type { ApiKeyQuotaUsage, GatewayApiKeyConfig } from "~/lib/types/api-key"

interface ApiKeyView {
  id: string
  name: string
  keyHint: string
  enabled: boolean
  expiresAt: string | null
  allowedModels: Array<string> | null
  quota: { period: string; amount: number } | null
  usage: {
    usedAmount: number
    remainingAmount: number | null
    resetsAt: number | null
  }
}

type QuotaUsage = Omit<ApiKeyQuotaUsage, "id">

interface ApiKeyAdminRouteOptions {
  store?: GatewayApiKeyStore
  getUsage?: (key: GatewayApiKeyConfig) => Promise<QuotaUsage>
}

const ID_PATTERN = /^[\w-]{1,128}$/u

class ApiKeyInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApiKeyInputError"
  }
}

function errorBody(message: string, type: string) {
  return { error: { message, type } }
}

function redact(message: string, secret: string | undefined): string {
  return secret && secret.length > 0 ?
      message.replaceAll(secret, "[redacted]")
    : message
}

type ApiKeyStatus = 400 | 404 | 503

function statusFor(error: unknown): ApiKeyStatus {
  if (error instanceof GatewayApiKeyStoreError) {
    if (error.code === "not_found") return 404
    if (error.code === "unavailable") return 503
    return 400
  }
  return 400
}

function typeFor(status: ApiKeyStatus): string {
  if (status === 404) return "not_found_error"
  if (status === 503) return "service_unavailable_error"
  return "invalid_request_error"
}

async function readJsonObject(c: {
  req: { json: () => Promise<unknown> }
}): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw new ApiKeyInputError("Request body must be valid JSON")
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiKeyInputError("Request body must be a JSON object")
  }
  return body as Record<string, unknown>
}

function validateId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new ApiKeyInputError(
      "API key id must contain only letters, digits, underscores, or hyphens",
    )
  }
}

async function createView(
  key: GatewayApiKeyConfig,
  getUsage: (key: GatewayApiKeyConfig) => Promise<QuotaUsage>,
): Promise<ApiKeyView> {
  const usage = await getUsage(key)
  return {
    id: key.id,
    name: key.name ?? "",
    keyHint: key.keyHint ?? "",
    enabled: key.enabled !== false,
    expiresAt: key.expiresAt ?? null,
    allowedModels: key.allowedModels ?? null,
    quota:
      key.quota ? { period: key.quota.period, amount: key.quota.amount } : null,
    usage: {
      usedAmount: usage.usedAmount,
      remainingAmount: usage.remainingAmount ?? null,
      resetsAt: usage.resetsAt ?? null,
    },
  }
}

export function createApiKeyAdminRoutes(
  options: ApiKeyAdminRouteOptions = {},
): Hono {
  const store = options.store ?? gatewayApiKeyStore
  const getUsage = options.getUsage ?? getApiKeyQuotaUsage
  const routes = new Hono()

  const respondWithError = (c: Context, error: unknown, secret?: string) => {
    const status = statusFor(error)
    const rawMessage =
      error instanceof Error ? error.message : "API key request failed"
    const message = redact(rawMessage, secret)
    if (status >= 500) {
      consola.error(`Gateway API key request failed: ${message}`)
    }
    return c.json(errorBody(message, typeFor(status)), status)
  }

  routes.get("/", async (c) => {
    try {
      const keys =
        store.hasDatabase() ?
          await store.listKeys()
        : normalizeApiKeyRecords(getConfig().auth?.apiKeyConfigs)
      const views = await Promise.all(
        keys.map(async (key) => await createView(key, getUsage)),
      )
      return c.json({ keys: views })
    } catch (error) {
      return respondWithError(c, error)
    }
  })

  routes.post("/", async (c) => {
    let secret: string | undefined
    try {
      const body = await readJsonObject(c)
      if (body.keyHash !== undefined) {
        throw new ApiKeyInputError("keyHash cannot be supplied")
      }
      if (
        body.key !== undefined
        && body.key !== null
        && (typeof body.key !== "string" || !body.key.trim())
      ) {
        throw new ApiKeyInputError("key must be a non-empty string")
      }
      secret =
        body.key === undefined || body.key === null || body.key === "" ?
          generateGatewayApiKey()
        : body.key
      const input: GatewayApiKeyCreateInput = {
        key: secret,
        ...(body.name !== undefined && { name: body.name as string }),
        ...(body.enabled !== undefined && { enabled: body.enabled as boolean }),
        ...(body.expiresAt !== undefined && {
          expiresAt: body.expiresAt as string | null,
        }),
        ...(body.allowedModels !== undefined && {
          allowedModels: body.allowedModels as Array<string> | null,
        }),
        ...(body.quota !== undefined && {
          quota: body.quota as GatewayApiKeyCreateInput["quota"],
        }),
      }
      const created = await store.create(input)
      return c.json(
        {
          key: secret,
          view: await createView(created.config, getUsage),
        },
        201,
      )
    } catch (error) {
      return respondWithError(c, error, secret)
    }
  })

  routes.patch("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      validateId(id)
      const body = await readJsonObject(c)
      if (body.key !== undefined || body.keyHash !== undefined) {
        throw new ApiKeyInputError("key and keyHash cannot be changed")
      }
      const patch: GatewayApiKeyUpdateInput = {
        ...(body.name !== undefined && { name: body.name as string }),
        ...(body.enabled !== undefined && { enabled: body.enabled as boolean }),
        ...(body.expiresAt !== undefined && {
          expiresAt: body.expiresAt as string | null,
        }),
        ...(body.allowedModels !== undefined && {
          allowedModels: body.allowedModels as Array<string> | null,
        }),
        ...(body.quota !== undefined && {
          quota: body.quota as GatewayApiKeyUpdateInput["quota"],
        }),
      }
      const updated = await store.update(id, patch)
      return c.json({ view: await createView(updated, getUsage) })
    } catch (error) {
      return respondWithError(c, error)
    }
  })

  routes.delete("/:id", async (c) => {
    try {
      const id = c.req.param("id")
      validateId(id)
      await store.delete(id)
      return c.body(null, 204)
    } catch (error) {
      return respondWithError(c, error)
    }
  })

  return routes
}

export const apiKeyAdminRoutes = createApiKeyAdminRoutes()

// Legacy usage endpoint: still returns plain quota records for the dashboard.
export const apiKeyUsageRoutes = new Hono()
apiKeyUsageRoutes.get("/", async (c) => {
  const keys =
    gatewayApiKeyStore.hasDatabase() ?
      await gatewayApiKeyStore.listKeys()
    : normalizeApiKeyRecords(getConfig().auth?.apiKeyConfigs)
  const usage = await Promise.all(
    keys.map(async (key) => ({
      id: key.id,
      ...(await getApiKeyQuotaUsage(key)),
    })),
  )
  return c.json(usage)
})
