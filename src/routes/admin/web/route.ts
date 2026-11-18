import { Hono, type Context } from "hono"

import { setProviderConfig } from "~/lib/provider-config"
import { readEditableConfigFromDisk } from "~/lib/config-store"
import { writeConfigToDisk, reloadConfig } from "~/lib/config-store"
import type { ProviderConfig } from "~/lib/config-store"
import { redactText } from "~/lib/redact"
import { parseFetchCapture, toSessionInput } from "~/services/web/fetch-capture"
import { getWebAdapter, listWebAdapters } from "~/services/web/registry"
import {
  WebSessionError,
  type WebProviderAdapter,
  type WebSessionInput,
  type WebSessionStatus,
} from "~/services/web/types"

interface InstanceState {
  status: "active" | "expired" | "unchecked"
  accountLabel?: string
  modelCount?: number
  lastCheckedAt?: number
  error?: string
}

const states = new Map<string, InstanceState>()

export interface WebAdminDeps {
  adapters: () => Array<WebProviderAdapter>
  getAdapter: (id: string) => WebProviderAdapter | null
  readProviders: () => Record<string, ProviderConfig>
  saveProvider: (name: string, provider: ProviderConfig) => void
  writeProviders: (providers: Record<string, ProviderConfig>) => void
}

export function defaultWebAdminDeps(): WebAdminDeps {
  return {
    adapters: listWebAdapters,
    getAdapter: getWebAdapter,
    readProviders: () => readEditableConfigFromDisk().providers ?? {},
    saveProvider: (name, provider) => {
      setProviderConfig(name, provider)
    },
    writeProviders: (providers) => {
      const config = readEditableConfigFromDisk()
      writeConfigToDisk({ ...config, providers })
      reloadConfig()
    },
  }
}

/** Finds the config entry serving one adapter (legacy chatgpt or type web). */
export function findWebInstance(
  adapterId: string,
  providers: Record<string, ProviderConfig>,
): { name: string; provider: ProviderConfig } | null {
  for (const [name, provider] of Object.entries(providers)) {
    if (provider.webAdapter === adapterId) return { name, provider }
    if (
      adapterId === "chatgpt"
      && name === "chatgpt"
      && provider.type === "chatgpt"
    ) {
      return { name, provider }
    }
  }
  return null
}

function sessionOf(provider: ProviderConfig): WebSessionInput {
  if (provider.cookie?.trim())
    return { kind: "cookie", value: provider.cookie.trim() }
  if (provider.apiKey?.trim())
    return { kind: "token", value: provider.apiKey.trim() }
  return { kind: "none" }
}

function errorJson(c: Context, error: unknown) {
  if (error instanceof WebSessionError) {
    return c.json(
      {
        error: {
          message: redactText(error.message),
          type: "web_session_error",
          code: error.code,
          loginHint: error.loginHint,
        },
      },
      error.status as 400,
    )
  }
  return c.json(
    {
      error: {
        message: redactText(
          error instanceof Error ? error.message : "Web admin failed",
        ),
        type: "error",
      },
    },
    500,
  )
}

export function createWebAdminRoutes(deps: WebAdminDeps): Hono {
  const routes = new Hono()

  routes.get("/providers", (c) => {
    const providers = deps.readProviders()
    const out = deps.adapters().map((adapter) => {
      const instance = findWebInstance(adapter.id, providers)
      const state = states.get(adapter.id)
      const configured = Boolean(
        instance
          && (instance.provider.cookie
            || instance.provider.apiKey
            || adapter.sessionKinds.includes("none")),
      )
      return {
        id: adapter.id,
        displayName: adapter.displayName,
        webUrl: adapter.webUrl,
        loginHint: adapter.loginHint,
        sessionKinds: adapter.sessionKinds,
        configured,
        enabled: instance?.provider.enabled !== false && Boolean(instance),
        status: !configured ? "unconfigured" : (state?.status ?? "unchecked"),
        accountLabel: state?.accountLabel ?? null,
        modelCount: state?.modelCount ?? null,
        lastCheckedAt: state?.lastCheckedAt ?? null,
        error: state?.error ?? null,
      }
    })
    return c.json({ providers: out })
  })

  routes.post("/providers/:id/session", async (c) => {
    const adapter = deps.getAdapter(c.req.param("id"))
    if (!adapter)
      return c.json(
        {
          error: {
            message: "Unknown web provider",
            type: "invalid_request_error",
          },
        },
        404,
      )
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        kind?: string
        value?: string
      }
      const kind = body.kind ?? "cookie"
      const rawValue = body.value ?? ""
      let captureInfo: { url: string; cookieNames: Array<string> } | null = null
      let input: WebSessionInput
      if (kind === "fetch-capture" || rawValue.trim().startsWith("fetch(")) {
        const parsed = parseFetchCapture(rawValue)
        captureInfo = { url: parsed.url, cookieNames: parsed.cookieNames }
        input = parsed.input
      } else {
        input = toSessionInput(kind, rawValue)
      }
      if (input.kind === "none" || !input.value) {
        throw new WebSessionError(
          400,
          "web_session_empty",
          adapter.loginHint,
          "No cookie or token found in the pasted session. "
            + adapter.loginHint,
        )
      }
      const providers = deps.readProviders()
      const existing = findWebInstance(adapter.id, providers)
      const name = existing?.name ?? adapter.id
      const base: ProviderConfig =
        existing?.provider
        ?? (adapter.id === "chatgpt" ?
          { type: "chatgpt", enabled: true }
        : { type: "web", webAdapter: adapter.id, enabled: true })
      const next: ProviderConfig = {
        ...base,
        enabled: true,
        ...(input.kind === "cookie" ?
          { cookie: input.value, apiKey: undefined }
        : {}),
        ...(input.kind === "token" ?
          { apiKey: input.value, cookie: undefined }
        : {}),
      }
      deps.saveProvider(name, next)
      states.set(adapter.id, { status: "unchecked" })
      return c.json({
        ok: true,
        ...(captureInfo ?
          {
            capture: {
              url: captureInfo.url,
              cookieNames: captureInfo.cookieNames,
            },
          }
        : {}),
      })
    } catch (error) {
      return errorJson(c, error)
    }
  })

  routes.post("/providers/:id/validate", async (c) => {
    const adapter = deps.getAdapter(c.req.param("id"))
    if (!adapter)
      return c.json(
        {
          error: {
            message: "Unknown web provider",
            type: "invalid_request_error",
          },
        },
        404,
      )
    const providers = deps.readProviders()
    const instance = findWebInstance(adapter.id, providers)
    const input =
      instance ? sessionOf(instance.provider) : { kind: "none" as const }
    try {
      const status: WebSessionStatus = await adapter.validateSession(input, {
        signal: c.req.raw.signal,
      })
      states.set(adapter.id, {
        status: "active",
        accountLabel: status.accountLabel,
        modelCount: status.modelCount,
        lastCheckedAt: Date.now(),
      })
      return c.json({ ok: true, status: "active", ...status })
    } catch (error) {
      states.set(adapter.id, {
        status: "expired",
        lastCheckedAt: Date.now(),
        error:
          error instanceof Error ?
            redactText(error.message)
          : "Session invalid",
      })
      return errorJson(c, error)
    }
  })

  routes.delete("/providers/:id/session", (c) => {
    const adapter = deps.getAdapter(c.req.param("id"))
    if (!adapter)
      return c.json(
        {
          error: {
            message: "Unknown web provider",
            type: "invalid_request_error",
          },
        },
        404,
      )
    const providers = { ...deps.readProviders() }
    const instance = findWebInstance(adapter.id, providers)
    if (instance) {
      const { cookie: _cookie, apiKey: _apiKey, ...rest } = instance.provider
      providers[instance.name] = { ...rest, enabled: false }
      deps.writeProviders(providers)
    }
    states.delete(adapter.id)
    return c.json({ ok: true })
  })

  routes.post("/providers/:id/test-chat", async (c) => {
    const adapter = deps.getAdapter(c.req.param("id"))
    if (!adapter)
      return c.json(
        {
          error: {
            message: "Unknown web provider",
            type: "invalid_request_error",
          },
        },
        404,
      )
    const providers = deps.readProviders()
    const instance = findWebInstance(adapter.id, providers)
    if (!instance) {
      return c.json(
        {
          error: {
            message: "Web provider is not configured",
            type: "invalid_request_error",
            loginHint: adapter.loginHint,
          },
        },
        400,
      )
    }
    try {
      const models = await adapter.listModels(sessionOf(instance.provider), {
        signal: c.req.raw.signal,
      })
      const model = models[0]
      if (!model) throw new Error("No models available for this web provider.")
      const started = Date.now()
      const { getProviderConfig } = await import("~/lib/provider-config")
      const resolved = getProviderConfig(instance.name)
      if (!resolved)
        throw new Error("Web provider config could not be resolved.")
      const response = await adapter.chatCompletion(
        resolved,
        {
          model: model.id,
          messages: [{ role: "user", content: "Hallo, antworte nur mit OK" }],
          stream: false,
        },
        { clientSignal: c.req.raw.signal },
      )
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      return c.json({
        ok: response.ok,
        model: model.id,
        latencyMs: Date.now() - started,
        reply: (data.choices?.[0]?.message?.content ?? "").slice(0, 200),
      })
    } catch (error) {
      return errorJson(c, error)
    }
  })

  return routes
}

export const webAdminRoutes = createWebAdminRoutes(defaultWebAdminDeps())

/** Test/reset hook for the in-memory status cache. */
export function resetWebAdminStates(): void {
  states.clear()
}
