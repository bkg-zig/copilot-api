import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

import { getConfig } from "./config"
import { normalizeApiKeyRecords, isApiKeyActive } from "./api-key-config"
import { requestContext } from "./request-context"

interface AuthMiddlewareOptions {
  getApiKeys?: () => Array<string>
  allowUnauthenticatedPaths?: Array<string>
  allowOptionsBypass?: boolean
  allowWhenNoApiKeys?: boolean
  shouldSkipPath?: (path: string) => boolean
  /** Accepts a request without an API key, e.g. via a login session cookie. */
  isAuthorizedBySession?: (c: Context) => boolean | Promise<boolean>
}

export function normalizeApiKeys(apiKeys: unknown): Array<string> {
  if (!Array.isArray(apiKeys)) {
    if (apiKeys !== undefined) {
      consola.warn("Invalid auth.apiKeys config. Expected an array of strings.")
    }
    return []
  }

  const normalizedKeys = apiKeys
    .filter((key): key is string => typeof key === "string")
    .map((key) => key.trim())
    .filter((key) => key.length > 0)

  if (normalizedKeys.length !== apiKeys.length) {
    consola.warn(
      "Invalid auth.apiKeys entries found. Only non-empty strings are allowed.",
    )
  }

  return [...new Set(normalizedKeys)]
}

export function getConfiguredApiKeys(): Array<string> {
  const config = getConfig()
  return normalizeApiKeyRecords(config.auth?.apiKeyConfigs).map(
    (entry) => entry.key,
  )
}

export function getMissingApiKeysMessage(): string | null {
  const apiKeys = getConfiguredApiKeys()
  if (apiKeys.length > 0) {
    return null
  }

  return [
    "Requests currently bypass authentication.",
    "Run `npx @jeffreycao/copilot-api@latest auth keys --add <key>` to enable API key auth.",
  ].join(" ")
}

function normalizeApiKey(apiKey: unknown): string | null {
  if (typeof apiKey !== "string") {
    return null
  }

  const normalizedApiKey = apiKey.trim()
  return normalizedApiKey || null
}

export function getConfiguredAdminApiKeys(): Array<string> {
  const config = getConfig()
  const adminApiKey = normalizeApiKey(config.auth?.adminApiKey)
  return adminApiKey ? [adminApiKey] : []
}

/**
 * Restricted "API creator" keys. They are accepted only on the gateway API-key
 * management routes (`/admin/api-keys*`) and may only list and create keys.
 */
export function getConfiguredApiCreatorApiKeys(): Array<string> {
  const config = getConfig()
  const creatorApiKey = normalizeApiKey(config.auth?.apiCreatorApiKey)
  return creatorApiKey ? [creatorApiKey] : []
}

/** True when the path belongs to the API-key management routes. */
export function isApiKeyManagementPath(path: string): boolean {
  return path === "/admin/api-keys" || path.startsWith("/admin/api-keys/")
}

/**
 * Paths the restricted "API creator" key may reach: the API-key management
 * routes (list/create only, enforced in the handlers) and the read-only token
 * usage/monitoring routes that power the dashboard "Log" view.
 */
export function isCreatorAllowedPath(path: string): boolean {
  return (
    isApiKeyManagementPath(path)
    || path === "/admin/token-usage"
    || path.startsWith("/admin/token-usage/")
  )
}

export function getIsolatedApiKeyId(): string | undefined {
  const id = requestContext.getStore()?.apiKey?.id
  return id !== undefined && getConfig().auth?.isolateApiKeyUsage === true ?
      id
    : undefined
}

export function extractRequestApiKey(c: Context): string | null {
  const xApiKey = c.req.header("x-api-key")?.trim()
  if (xApiKey) {
    return xApiKey
  }

  const authorization = c.req.header("authorization")
  if (!authorization) {
    return null
  }

  const [scheme, ...rest] = authorization.trim().split(/\s+/)
  if (scheme.toLowerCase() !== "bearer") {
    return null
  }

  const bearerToken = rest.join(" ").trim()
  return bearerToken || null
}

function createUnauthorizedResponse(c: Context): Response {
  c.header("WWW-Authenticate", 'Bearer realm="copilot-api"')
  return c.json(
    {
      error: {
        message: "Unauthorized",
        type: "authentication_error",
      },
    },
    401,
  )
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareHandler {
  // The configured-key reader uses managed policies even when passed explicitly.
  const getApiKeys =
    options.getApiKeys === getConfiguredApiKeys ? undefined : options.getApiKeys
  const allowUnauthenticatedPaths = options.allowUnauthenticatedPaths ?? ["/"]
  const allowOptionsBypass = options.allowOptionsBypass ?? true
  const allowWhenNoApiKeys = options.allowWhenNoApiKeys ?? true
  const shouldSkipPath = options.shouldSkipPath ?? (() => false)
  const isAuthorizedBySession = options.isAuthorizedBySession ?? (() => false)

  return async (c, next) => {
    if (
      (allowOptionsBypass && c.req.method === "OPTIONS")
      || shouldSkipPath(c.req.path)
      || allowUnauthenticatedPaths.includes(c.req.path)
    ) {
      return next()
    }

    if (await isAuthorizedBySession(c)) {
      return next()
    }

    const auth = getApiKeys ? undefined : getConfig().auth
    const apiKeys =
      getApiKeys ? getApiKeys() : normalizeApiKeyRecords(auth?.apiKeyConfigs)
    if (apiKeys.length === 0) {
      return allowWhenNoApiKeys ? next() : createUnauthorizedResponse(c)
    }

    const requestApiKey = extractRequestApiKey(c)
    if (!requestApiKey) return createUnauthorizedResponse(c)

    const key = apiKeys.find((entry) => {
      if (typeof entry === "string") return entry === requestApiKey
      return !getApiKeys && entry.key === requestApiKey
    })
    if (key === undefined) return createUnauthorizedResponse(c)
    if (typeof key === "string") return next()
    if (!isApiKeyActive(key)) return createUnauthorizedResponse(c)

    const context = requestContext.getStore()
    if (context) context.apiKey = key
    c.header(
      "X-API-Key-Usage-Isolated",
      String(auth?.isolateApiKeyUsage === true),
    )
    return next()
  }
}
