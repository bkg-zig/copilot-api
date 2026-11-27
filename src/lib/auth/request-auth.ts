import consola from "consola"
import type { Context, MiddlewareHandler } from "hono"

import { getConfig } from "../config"
import {
  hashGatewayApiKey,
  isApiKeyActive,
  normalizeApiKeyRecords,
  normalizeApiKeys,
  type GatewayApiKeyConfig,
} from "../config/api-key-config"
import { requestContext } from "../http/request-context"
import { gatewayApiKeyStore } from "./gateway-api-keys"

export { normalizeApiKeys }

interface AuthMiddlewareOptions {
  getApiKeys?: () => Array<string>
  getGatewayApiKeys?:
    | (() => Promise<Array<GatewayApiKeyConfig>>)
    | (() => Array<GatewayApiKeyConfig>)
  allowUnauthenticatedPaths?: Array<string>
  allowOptionsBypass?: boolean
  allowWhenNoApiKeys?: boolean
  shouldSkipPath?: (path: string) => boolean
  authorizeRequest?: (c: Context) => Promise<boolean> | boolean
}

/**
 * Legacy config reader. Secrets that live only in Postgres are deliberately
 * absent: callers compare/add literal keys, and a masked hint would be neither
 * usable nor safe to print. Use getConfiguredApiKeyCount() for existence checks.
 */
export function getConfiguredApiKeys(): Array<string> {
  const config = getConfig()
  return normalizeApiKeyRecords(config.auth?.apiKeyConfigs).flatMap((entry) =>
    entry.key ? [entry.key] : [],
  )
}

export function getConfiguredApiKeyCount(): number {
  const databaseIdentities = gatewayApiKeyStore
    .peek()
    .map((entry) => entry.keyHash ?? entry.keyHint ?? entry.id)
  return new Set([...getConfiguredApiKeys(), ...databaseIdentities]).size
}

export function getMissingApiKeysMessage(): string | null {
  if (getConfiguredApiKeyCount() > 0) {
    return null
  }

  return [
    "Requests currently bypass authentication.",
    "Run `npx @jeffreycao/copilot-api@latest auth keys --add <key>` to enable API key auth.",
  ].join(" ")
}

/** Loads the Postgres-backed snapshot at startup; absence of Postgres is fine. */
export async function initializeGatewayApiKeys(): Promise<void> {
  if (!gatewayApiKeyStore.hasDatabase()) return
  try {
    await gatewayApiKeyStore.listKeys()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    consola.warn(`Gateway API key storage is unavailable: ${message}`)
  }
}

export async function getEffectiveGatewayApiKeys(): Promise<
  Array<GatewayApiKeyConfig>
> {
  return gatewayApiKeyStore.hasDatabase() ?
      await gatewayApiKeyStore.listKeys()
    : normalizeApiKeyRecords(getConfig().auth?.apiKeyConfigs)
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

  const xGoogApiKey = c.req.header("x-goog-api-key")?.trim()
  if (xGoogApiKey) {
    return xGoogApiKey
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

function createStorageUnavailableResponse(c: Context): Response {
  return c.json(
    {
      error: {
        message: "API key storage is unavailable",
        type: "service_unavailable_error",
      },
    },
    503,
  )
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareHandler {
  // An explicitly passed config reader keeps the legacy config policy, even
  // when Postgres is configured. All other callers use the authoritative DB.
  const explicitConfigReader = options.getApiKeys === getConfiguredApiKeys
  const getApiKeys = explicitConfigReader ? undefined : options.getApiKeys
  const readGatewayKeys =
    options.getGatewayApiKeys ?? (() => gatewayApiKeyStore.listKeys())
  const useGatewayStore =
    !getApiKeys
    && !explicitConfigReader
    && (options.getGatewayApiKeys !== undefined
      || gatewayApiKeyStore.hasDatabase())
  const allowUnauthenticatedPaths = options.allowUnauthenticatedPaths ?? ["/"]
  const allowOptionsBypass = options.allowOptionsBypass ?? true
  const allowWhenNoApiKeys = options.allowWhenNoApiKeys ?? true
  const shouldSkipPath = options.shouldSkipPath ?? (() => false)

  return async (c, next) => {
    if (
      (allowOptionsBypass && c.req.method === "OPTIONS")
      || shouldSkipPath(c.req.path)
      || allowUnauthenticatedPaths.includes(c.req.path)
    ) {
      return next()
    }

    if (options.authorizeRequest && (await options.authorizeRequest(c))) {
      return next()
    }

    const auth = getApiKeys ? undefined : getConfig().auth
    let apiKeys: Array<string | GatewayApiKeyConfig> = []
    let lookup: ((hash: string) => GatewayApiKeyConfig | undefined) | undefined

    if (getApiKeys) {
      apiKeys = getApiKeys()
    } else if (useGatewayStore) {
      try {
        if (options.getGatewayApiKeys === undefined) {
          await gatewayApiKeyStore.listKeys()
          lookup = (hash) => gatewayApiKeyStore.lookupByHash(hash)
          apiKeys = gatewayApiKeyStore.peek()
        } else {
          const records = await readGatewayKeys()
          const byHash = new Map<string, GatewayApiKeyConfig>()
          for (const record of records) {
            const hash =
              record.keyHash
              ?? (record.key ? hashGatewayApiKey(record.key) : undefined)
            if (hash) byHash.set(hash, record)
          }
          lookup = (hash) => byHash.get(hash)
          apiKeys = records
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        consola.error(`Gateway API key storage is unavailable: ${message}`)
        return createStorageUnavailableResponse(c)
      }
    } else {
      apiKeys = normalizeApiKeyRecords(auth?.apiKeyConfigs)
    }
    if (apiKeys.length === 0) {
      return allowWhenNoApiKeys ? next() : createUnauthorizedResponse(c)
    }

    const requestApiKey = extractRequestApiKey(c)
    if (!requestApiKey) return createUnauthorizedResponse(c)

    let key: string | GatewayApiKeyConfig | undefined
    if (lookup) {
      key = lookup(hashGatewayApiKey(requestApiKey))
    } else {
      key = apiKeys.find((entry) =>
        typeof entry === "string" ?
          entry === requestApiKey
        : entry.key === requestApiKey,
      )
    }
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
