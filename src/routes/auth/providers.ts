import { randomBytes } from "node:crypto"
import { Hono } from "hono"

import {
  getCodexAccounts,
  persistCodexCredentials,
  logUser,
} from "~/lib/auth/token"
import { getXaiAccounts, persistXaiCredentials } from "~/lib/auth/xai-token"
import { loginCodex } from "~/lib/auth/oauth/codex"
import { loginXai } from "~/lib/auth/oauth/xai"
import { readGitHubToken, writeGitHubToken } from "~/lib/auth/credential-store"
import { getDeviceCode } from "~/services/github/get-device-code"
import { pollAccessToken } from "~/services/github/poll-access-token"
import { state } from "~/lib/state"
import { getRawProviderConfig, setProviderConfig } from "~/lib/config"
import { QUICK_PROVIDER_CONFIGS } from "~/lib/config/quick-providers"
import { getWebAuthSession } from "~/lib/auth/web-session"

export const providerAuthRoutes = new Hono()

type ProviderName = "github-copilot" | "codex" | "xai"
type OperationStatus = "authorizing" | "connected" | "failed" | "cancelled"
type AuthInfo = {
  url: string
  verificationUri?: string
  userCode?: string
  instructions?: string
  expiresAt?: number
}
type AuthOperation = {
  id: string
  provider: ProviderName
  userId: number
  status: OperationStatus
  auth: AuthInfo | null
  error: string | null
  createdAt: number
  controller: AbortController
  resolveCode?: (value: string) => void
  rejectCode?: (reason: Error) => void
  resolveReady?: () => void
  ready: Promise<void>
}

const operations = new Map<string, AuthOperation>()
const OPERATION_TTL_MS = 10 * 60 * 1000

function createOperation(
  provider: ProviderName,
  userId: number,
): AuthOperation {
  const id = randomBytes(24).toString("base64url")
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const operation: AuthOperation = {
    id,
    provider,
    userId,
    status: "authorizing",
    auth: null,
    error: null,
    createdAt: Date.now(),
    controller: new AbortController(),
    resolveReady,
    ready,
  }
  operations.set(id, operation)
  for (const [key, item] of operations) {
    if (Date.now() - item.createdAt > OPERATION_TTL_MS) {
      item.controller.abort(new Error("Authorization operation expired"))
      operations.delete(key)
    }
  }
  return operation
}

function publishAuthInfo(operation: AuthOperation, auth: AuthInfo): void {
  operation.auth = auth
  operation.resolveReady?.()
  operation.resolveReady = undefined
}

function publicOperation(operation: AuthOperation) {
  return {
    id: operation.id,
    provider: operation.provider,
    status: operation.status,
    auth: operation.auth,
    error: operation.error,
    createdAt: operation.createdAt,
  }
}

async function startOperation(operation: AuthOperation): Promise<void> {
  try {
    if (operation.provider === "github-copilot") {
      const device = await getDeviceCode()
      publishAuthInfo(operation, {
        url: device.verification_uri,
        verificationUri: device.verification_uri,
        userCode: device.user_code,
        expiresAt: Date.now() + device.expires_in * 1000,
      })
      const token = await pollAccessToken(device, undefined, {
        signal: operation.controller.signal,
      })
      operation.controller.signal.throwIfAborted()
      await writeGitHubToken(token)
      state.githubToken = token
      await logUser()
    } else if (operation.provider === "codex") {
      const credentials = await loginCodex({
        onAuth: (info) => publishAuthInfo(operation, info),
        onPrompt: () =>
          Promise.reject(
            new Error("Bitte den OAuth-Callback in der WebUI einfügen."),
          ),
        onAuthorizationCode: (_state, signal) =>
          new Promise<string>((resolve, reject) => {
            operation.resolveCode = resolve
            operation.rejectCode = reject
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  signal.reason instanceof Error ?
                    signal.reason
                  : new Error("Authorization cancelled"),
                ),
              { once: true },
            )
          }),
        signal: operation.controller.signal,
      })
      await persistCodexCredentials(credentials, {
        activateAccount: true,
        enableProvider: false,
      })
    } else {
      const credentials = await loginXai({
        onAuth: (info) => publishAuthInfo(operation, info),
        signal: operation.controller.signal,
      })
      await persistXaiCredentials(credentials, { enableProvider: false })
    }
    operation.status = "connected"
  } catch (error) {
    if (operation.controller.signal.aborted) {
      operation.status = "cancelled"
    } else {
      operation.status = "failed"
      operation.error =
        error instanceof Error ? error.message : "Anmeldung fehlgeschlagen."
    }
  } finally {
    operation.resolveReady?.()
    operation.resolveReady = undefined
    operation.resolveCode = undefined
    operation.rejectCode = undefined
  }
}

async function requireWebUser(c: Parameters<typeof getWebAuthSession>[0]) {
  const user = await getWebAuthSession(c)
  if (!user) return null
  return user
}

providerAuthRoutes.get("/status", async (c) => {
  const user = await requireWebUser(c)
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  try {
    const [githubToken, codexAccounts, xaiAccounts] = await Promise.all([
      readGitHubToken(),
      getCodexAccounts(),
      getXaiAccounts(),
    ])
    const go = getRawProviderConfig("opencode-go")
    return c.json({
      providers: {
        "github-copilot": { connected: Boolean(githubToken), account: null },
        codex: {
          connected: codexAccounts.some((item) => item.active),
          accounts: codexAccounts,
        },
        xai: {
          connected: xaiAccounts.some((item) => item.active),
          accounts: xaiAccounts,
        },
        "opencode-go": {
          connected: Boolean(go?.enabled !== false && go?.apiKey?.trim()),
          requiresApiKey: true,
        },
      },
      operations: [...operations.values()]
        .filter((operation) => operation.userId === user.id)
        .map(publicOperation),
    })
  } catch {
    return c.json(
      { error: "Provider-Anmeldestatus konnte nicht geladen werden." },
      500,
    )
  }
})

providerAuthRoutes.post("/:provider/start", async (c) => {
  const user = await requireWebUser(c)
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const provider = c.req.param("provider")
  if (
    provider !== "github-copilot"
    && provider !== "codex"
    && provider !== "xai"
  ) {
    return c.json(
      { error: "Dieser Anbieter unterstützt keinen Web-OAuth-Login." },
      400,
    )
  }
  const existing = [...operations.values()].find(
    (item) =>
      item.userId === user.id
      && item.provider === provider
      && item.status === "authorizing",
  )
  if (existing) return c.json(publicOperation(existing))
  const operation = createOperation(provider, user.id)
  void startOperation(operation)
  await Promise.race([
    operation.ready,
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
  if (operation.status === "failed")
    return c.json(publicOperation(operation), 502)
  return c.json(publicOperation(operation), 202)
})

providerAuthRoutes.get("/operations/:id", async (c) => {
  const user = await requireWebUser(c)
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const operation = operations.get(c.req.param("id"))
  if (!operation || operation.userId !== user.id)
    return c.json({ error: "Anmeldevorgang nicht gefunden." }, 404)
  return c.json(publicOperation(operation))
})

providerAuthRoutes.post("/operations/:id/callback", async (c) => {
  const user = await requireWebUser(c)
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const operation = operations.get(c.req.param("id"))
  if (
    !operation
    || operation.userId !== user.id
    || operation.provider !== "codex"
    || operation.status !== "authorizing"
    || !operation.resolveCode
  ) {
    return c.json({ error: "Kein offener Codex-Anmeldevorgang." }, 409)
  }
  const body: unknown = await c.req.json().catch(() => null)
  const input =
    body && typeof body === "object" && !Array.isArray(body) ?
      (body as Record<string, unknown>).input
    : null
  if (typeof input !== "string" || !input.trim() || input.length > 8192) {
    return c.json(
      {
        error:
          "Bitte die vollständige Redirect-URL oder den OAuth-Code einfügen.",
      },
      400,
    )
  }
  operation.resolveCode(input.trim())
  operation.resolveCode = undefined
  return c.json({ accepted: true })
})

providerAuthRoutes.post("/operations/:id/cancel", async (c) => {
  const user = await requireWebUser(c)
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const operation = operations.get(c.req.param("id"))
  if (!operation || operation.userId !== user.id)
    return c.json({ error: "Anmeldevorgang nicht gefunden." }, 404)
  operation.controller.abort(new Error("Authorization cancelled by user"))
  operation.status = "cancelled"
  operation.resolveCode = undefined
  operation.rejectCode?.(new Error("Authorization cancelled by user"))
  return c.json({ cancelled: true })
})

providerAuthRoutes.post("/opencode-go", async (c) => {
  const user = await requireWebUser(c)
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  const body: unknown = await c.req.json().catch(() => null)
  const apiKey =
    body && typeof body === "object" && !Array.isArray(body) ?
      (body as Record<string, unknown>).apiKey
    : null
  if (
    typeof apiKey !== "string"
    || apiKey.trim().length < 8
    || apiKey.length > 4096
  ) {
    return c.json(
      { error: "Ein gültiger OpenCode-Go-API-Key ist erforderlich." },
      400,
    )
  }
  const current = getRawProviderConfig("opencode-go") ?? {}
  const defaults = QUICK_PROVIDER_CONFIGS["opencode-go"]
  setProviderConfig("opencode-go", {
    ...current,
    type: defaults.type,
    baseUrl: defaults.baseUrl,
    authType: "authorization",
    apiKey: apiKey.trim(),
    enabled: true,
    pricingCurrency: defaults.pricingCurrency,
  })
  return c.json({ connected: true })
})
