import { Hono, type Context } from "hono"
import { z } from "zod"

import {
  deleteAdminProvider,
  getAdminKeys,
  getAdminProviderModels,
  getAdminProviders,
  getAdminRouter,
  setAdminKeys,
  setAdminRouter,
  upsertAdminProvider,
} from "~/lib/admin-config"
import { forwardError } from "~/lib/error"
import { getModelMappings, setModelMappings } from "~/lib/config"
import {
  getVirtualModelsConfig,
  setVirtualModelsConfig,
  upsertVirtualModel,
  removeVirtualModel,
  getCombosConfig,
  setCombosConfig,
  upsertCombo,
  removeCombo,
} from "~/lib/model-policy"
import { reloadServerConfig } from "~/lib/config-reload"
import { githubAuthRoutes } from "./github-accounts-route"
import { stripInternalRequestHeaders } from "~/lib/internal-headers"
import { PATHS } from "~/lib/paths"
import { getAgentModels } from "~/routes/models/model-discovery"
import {
  CODEX_CLIENT_ID,
  completeCodexAuth,
  createCodexAuthUrl,
} from "~/lib/oauth/codex"
import {
  CodexDeviceLoginError,
  createCodexDeviceLogin,
  defaultSleep,
} from "~/lib/oauth/codex-device-login"
import {
  CodexWebLoginError,
  createCodexWebLogin,
  normalizeCodexAlias,
} from "~/lib/oauth/codex-web-login"
import {
  createXaiDeviceLogin,
  XaiDeviceLoginError,
} from "~/lib/oauth/xai-device-login"
import {
  ClaudeOAuthError,
  createClaudeOAuthLogin,
} from "~/lib/claude-code/oauth"
import { syncClaudeProviderConfig } from "~/lib/claude-code/provider"
import {
  getCodexAccounts,
  selectCodexAccount,
  removeCodexAccount,
  renameCodexAccount,
  persistCodexCredentials,
} from "~/lib/token"
import {
  getXaiAccounts,
  persistXaiCredentials,
  removeXaiAccount,
  renameXaiAccount,
  selectXaiAccount,
} from "~/lib/xai-token"
import {
  readCodexCredentialStore,
  updateCodexAccountCapabilities,
} from "~/lib/credential-store"
import {
  writeConfigToDisk,
  readEditableConfigFromDisk,
} from "~/lib/config-store"

export const configRoutes = new Hono()

const modelMappingsRequestSchema = z.object({
  modelMappings: z.record(z.string(), z.string()),
})

async function reload(): Promise<void> {
  try {
    await reloadServerConfig()
  } catch {
    // A failed hot reload must not fail an otherwise persisted admin write.
  }
}

configRoutes.post("/reload", async (c) => {
  try {
    await reloadServerConfig()
    return c.json({ configPath: PATHS.CONFIG_PATH, reloaded: true })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.get("/model-mappings", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    modelMappings: getModelMappings(),
  })
})

configRoutes.post("/model-mappings", async (c) => {
  try {
    const parseResult = modelMappingsRequestSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const updatedModelMappings = setModelMappings(
      parseResult.data.modelMappings,
    )

    return c.json({
      configPath: PATHS.CONFIG_PATH,
      modelMappings: updatedModelMappings,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

// Virtual Models (advanced model mappings with provider allowlists, context caps, versions)
const virtualModelConfigSchema = z.object({
  target: z.string().min(1),
  allowedProviders: z.array(z.string()).optional(),
  contextWindow: z.number().positive().optional(),
  version: z.enum(["v1", "base", "v2"]).optional(),
  v2ThreadLimit: z.number().positive().optional(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

const virtualModelsRequestSchema = z.object({
  models: z.record(z.string(), virtualModelConfigSchema),
  defaults: z
    .object({
      version: z.enum(["v1", "base", "v2"]).optional(),
      v2ThreadLimit: z.number().positive().optional(),
      contextWindow: z.number().positive().optional(),
    })
    .optional(),
})

configRoutes.get("/virtual-models", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    virtualModels: getVirtualModelsConfig(),
  })
})

configRoutes.post("/virtual-models", async (c) => {
  try {
    const parseResult = virtualModelsRequestSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const updatedVirtualModels = setVirtualModelsConfig(parseResult.data)
    return c.json({
      configPath: PATHS.CONFIG_PATH,
      virtualModels: updatedVirtualModels,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

const upsertVirtualModelSchema = z.object({
  name: z.string().min(1),
  config: virtualModelConfigSchema,
})

configRoutes.post("/virtual-models/upsert", async (c) => {
  try {
    const parseResult = upsertVirtualModelSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const { name, config } = parseResult.data
    const updatedVirtualModels = upsertVirtualModel(name, config)
    return c.json({
      configPath: PATHS.CONFIG_PATH,
      virtualModels: updatedVirtualModels,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.delete("/virtual-models/:name", async (c) => {
  try {
    const name = c.req.param("name")
    const updatedVirtualModels = removeVirtualModel(name)
    return c.json({
      configPath: PATHS.CONFIG_PATH,
      virtualModels: updatedVirtualModels,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

// Combos: failover and load balancing across providers
const comboTargetSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  weight: z.number().positive().max(10000).optional(),
  lastResort: z.boolean().optional(),
  metered: z.boolean().optional(),
})

const comboConfigSchema = z.object({
  targets: z.array(comboTargetSchema).min(1),
  strategy: z
    .enum([
      "failover",
      "round-robin",
      "random",
      "least-used",
      "reset-window",
      "jev",
    ])
    .optional(),
  stickyLimit: z.number().positive().max(100).optional(),
  cooldownMs: z.number().positive().max(600000).optional(),
  waitForCooldownMs: z.number().min(0).max(600000).optional(),
  cooldownWaitPolicy: z.literal("before-last-resort").optional(),
  defaultEffort: z
    .enum(["low", "medium", "high", "xhigh", "max", "ultra"])
    .nullable()
    .optional(),
  defaultEffortMode: z.enum(["fallback", "force"]).optional(),
  reasoningEffortMode: z.enum(["strict", "adaptive"]).optional(),
  jevEffortMode: z.enum(["decide", "client"]).optional(),
  imageInput: z.enum(["auto", "disabled"]).optional(),
  alias: z.string().optional(),
  nativeAlias: z.boolean().optional(),
  displayName: z.string().optional(),
  decisionProvider: z.string().optional(),
  decisionModel: z.string().optional(),
  decisionTimeoutMs: z.number().min(1000).max(120000).optional(),
  decisionQuotaSignals: z.boolean().optional(),
  decisionQuotaTiers: z
    .object({
      moderate: z.number().min(0).max(100).optional(),
      limited: z.number().min(0).max(100).optional(),
      nearlyExhausted: z.number().min(0).max(100).optional(),
    })
    .optional(),
  sessionPin: z
    .object({
      ttlMs: z.number().min(60000).max(86400000),
    })
    .nullable()
    .optional(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

const combosRequestSchema = z.object({
  combos: z.record(z.string(), comboConfigSchema),
})

configRoutes.get("/combos", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    combos: getCombosConfig(),
  })
})

configRoutes.post("/combos", async (c) => {
  try {
    const parseResult = combosRequestSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const updatedCombos = setCombosConfig(parseResult.data)
    return c.json({
      configPath: PATHS.CONFIG_PATH,
      combos: updatedCombos,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

const upsertComboSchema = z.object({
  name: z.string().min(1),
  config: comboConfigSchema,
})

configRoutes.post("/combos/upsert", async (c) => {
  try {
    const parseResult = upsertComboSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const { name, config } = parseResult.data
    const updatedCombos = upsertCombo(name, config)
    return c.json({
      configPath: PATHS.CONFIG_PATH,
      combos: updatedCombos,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.delete("/combos/:name", async (c) => {
  try {
    const name = c.req.param("name")
    const updatedCombos = removeCombo(name)
    return c.json({
      configPath: PATHS.CONFIG_PATH,
      combos: updatedCombos,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.get("/providers", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    providers: getAdminProviders(),
  })
})

configRoutes.get("/providers/:name/models", (c) => {
  const name = c.req.param("name")
  const models = getAdminProviderModels(name)
  return c.json({ configPath: PATHS.CONFIG_PATH, models })
})

// Models the gateway can actually serve. Honors each provider's `agentsModels`
// selection, so the Admin settings only offer usable models.
configRoutes.get("/models", async (c) => {
  try {
    const models = await getAgentModels(
      stripInternalRequestHeaders(c.req.raw.headers),
      { includeImageModels: false },
    )
    return c.json({ configPath: PATHS.CONFIG_PATH, models })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.post("/providers", async (c) => {
  try {
    const providers = upsertAdminProvider(await c.req.json())
    await reload()
    return c.json({ configPath: PATHS.CONFIG_PATH, providers })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.delete("/providers/:name", async (c) => {
  try {
    const providers = deleteAdminProvider(c.req.param("name"))
    await reload()
    return c.json({ configPath: PATHS.CONFIG_PATH, providers })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.get("/keys", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    ...getAdminKeys(),
  })
})

configRoutes.post("/keys", async (c) => {
  try {
    const keys = setAdminKeys(await c.req.json())
    await reload()
    return c.json({ configPath: PATHS.CONFIG_PATH, ...keys })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.get("/router", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    router: getAdminRouter(),
  })
})

configRoutes.post("/router", async (c) => {
  try {
    const router = setAdminRouter(await c.req.json())
    await reload()
    return c.json({ configPath: PATHS.CONFIG_PATH, router })
  } catch (error) {
    return await forwardError(c, error)
  }
})

// Codex sign-in for headless servers: the dashboard opens the OpenAI login,
// the user pastes the localhost redirect address back. See codex-web-login.ts.
const codexWebLogin = createCodexWebLogin({
  createAuthUrl: createCodexAuthUrl,
  completeAuth: completeCodexAuth,
  persist: async (credentials, alias) => {
    await persistCodexCredentials(credentials, {
      activateAccount: true,
      alias,
      enableProvider: true,
    })
    await reloadServerConfig()
  },
  now: Date.now,
})

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json()
    return body && typeof body === "object" ?
        (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

configRoutes.post("/auth/codex/start", async (c) => {
  try {
    const body = await readJsonBody(c)
    return c.json(await codexWebLogin.start(body.alias))
  } catch (error) {
    if (error instanceof CodexWebLoginError) {
      return c.json(
        { error: { message: error.message, type: "invalid_request_error" } },
        400,
      )
    }
    return await forwardError(c, error)
  }
})

configRoutes.post("/auth/codex/complete", async (c) => {
  try {
    const body = await readJsonBody(c)
    const result = await codexWebLogin.finish(body.state, body.input)
    return c.json({ success: true, ...result })
  } catch (error) {
    if (error instanceof CodexWebLoginError) {
      return c.json(
        { error: { message: error.message, type: "invalid_request_error" } },
        400,
      )
    }
    return await forwardError(c, error)
  }
})

// Codex sign-in with a device code: the dashboard shows a short code, the user
// confirms it at OpenAI, the server polls in the background. See
// codex-device-login.ts. Preferred over the paste flow above.
const codexDeviceLogin = createCodexDeviceLogin({
  clientId: CODEX_CLIENT_ID,
  fetch: (input, init) => fetch(input, init),
  sleep: defaultSleep,
  now: Date.now,
  exchange: ({ code, verifier, redirectUri }) =>
    completeCodexAuth({ code, verifier, redirectUri, state: "" }),
  persist: async (credentials, alias) => {
    await persistCodexCredentials(credentials, {
      activateAccount: true,
      alias,
      enableProvider: true,
    })
    await reloadServerConfig()
  },
})

function codexLoginErrorResponse(c: Context, error: unknown) {
  if (
    error instanceof CodexDeviceLoginError
    || error instanceof CodexWebLoginError
  ) {
    return c.json(
      { error: { message: error.message, type: "invalid_request_error" } },
      400,
    )
  }
  return null
}

configRoutes.post("/auth/codex/device/start", async (c) => {
  try {
    const body = await readJsonBody(c)
    return c.json(await codexDeviceLogin.start(normalizeCodexAlias(body.alias)))
  } catch (error) {
    return codexLoginErrorResponse(c, error) ?? (await forwardError(c, error))
  }
})

configRoutes.get("/auth/codex/device/:flowId", (c) => {
  const status = codexDeviceLogin.status(c.req.param("flowId"))
  if (!status) {
    return c.json(
      { error: { message: "Sign-in not found.", type: "not_found" } },
      404,
    )
  }
  return c.json(status)
})

configRoutes.delete("/auth/codex/device/:flowId", (c) => {
  const status = codexDeviceLogin.cancel(c.req.param("flowId"))
  if (!status) {
    return c.json(
      { error: { message: "Sign-in not found.", type: "not_found" } },
      404,
    )
  }
  return c.json(status)
})

// xAI (Grok) subscription sign-in with a device code.
const xaiDeviceLogin = createXaiDeviceLogin({
  fetch: (input, init) => fetch(input, init),
  sleep: defaultSleep,
  now: Date.now,
  persist: async (credentials, alias) => {
    await persistXaiCredentials(credentials, { alias })
    await reloadServerConfig()
  },
})

function xaiLoginErrorResponse(c: Context, error: unknown) {
  if (error instanceof XaiDeviceLoginError) {
    return c.json(
      { error: { message: error.message, type: "invalid_request_error" } },
      400,
    )
  }
  return null
}

configRoutes.post("/auth/xai/device/start", async (c) => {
  try {
    const body = await readJsonBody(c)
    return c.json(await xaiDeviceLogin.start(normalizeCodexAlias(body.alias)))
  } catch (error) {
    return xaiLoginErrorResponse(c, error) ?? (await forwardError(c, error))
  }
})

configRoutes.get("/auth/xai/device/:flowId", (c) => {
  const status = xaiDeviceLogin.status(c.req.param("flowId"))
  if (!status) {
    return c.json(
      { error: { message: "Sign-in not found.", type: "not_found" } },
      404,
    )
  }
  return c.json(status)
})

configRoutes.delete("/auth/xai/device/:flowId", (c) => {
  const status = xaiDeviceLogin.cancel(c.req.param("flowId"))
  if (!status) {
    return c.json(
      { error: { message: "Sign-in not found.", type: "not_found" } },
      404,
    )
  }
  return c.json(status)
})

// GitHub Copilot sign-in and account switching. See github-accounts-route.ts.
configRoutes.route("/", githubAuthRoutes)

// Codex account management endpoints
configRoutes.get("/codex/accounts", async (c) => {
  try {
    const accounts = await getCodexAccounts()
    return c.json({ accounts })
  } catch (error) {
    return await forwardError(c, error)
  }
})

// xAI account management endpoints
configRoutes.get("/xai/accounts", async (c) => {
  try {
    const accounts = await getXaiAccounts()
    return c.json({ accounts })
  } catch (error) {
    return await forwardError(c, error)
  }
})

const selectXaiAccountSchema = z.object({
  accountId: z.string().min(1),
})

configRoutes.post("/xai/accounts/select", async (c) => {
  try {
    const parseResult = selectXaiAccountSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }
    const account = await selectXaiAccount(parseResult.data.accountId)
    await reloadServerConfig()
    return c.json({ success: true, account })
  } catch (error) {
    return await forwardError(c, error)
  }
})

const removeXaiAccountSchema = z.object({
  accountId: z.string().min(1),
})

configRoutes.post("/xai/accounts/remove", async (c) => {
  try {
    const parseResult = removeXaiAccountSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }
    const account = await removeXaiAccount(parseResult.data.accountId)
    await reloadServerConfig()
    return c.json({ success: true, account })
  } catch (error) {
    return await forwardError(c, error)
  }
})

const renameXaiAccountSchema = z.object({
  alias: z.string().trim().min(1).max(64),
})

configRoutes.patch("/xai/accounts/:accountId", async (c) => {
  try {
    const parseResult = renameXaiAccountSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid account name.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }
    const account = await renameXaiAccount(
      decodeURIComponent(c.req.param("accountId")),
      parseResult.data.alias,
    )
    return c.json({ success: true, account })
  } catch (error) {
    return await forwardError(c, error)
  }
})

const selectCodexAccountSchema = z.object({
  accountId: z.string().min(1),
})

configRoutes.post("/codex/accounts/select", async (c) => {
  try {
    const parseResult = selectCodexAccountSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const { accountId } = parseResult.data
    const account = await selectCodexAccount(accountId)
    await reloadServerConfig()
    return c.json({ success: true, account })
  } catch (error) {
    return await forwardError(c, error)
  }
})

const removeCodexAccountSchema = z.object({
  accountId: z.string().min(1),
})

configRoutes.post("/codex/accounts/remove", async (c) => {
  try {
    const parseResult = removeCodexAccountSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const { accountId } = parseResult.data
    const account = await removeCodexAccount(accountId)
    await reloadServerConfig()
    return c.json({ success: true, account })
  } catch (error) {
    return await forwardError(c, error)
  }
})

const renameCodexAccountSchema = z.object({
  alias: z.string().trim().min(1).max(64),
})

configRoutes.patch("/codex/accounts/:accountId", async (c) => {
  try {
    const parseResult = renameCodexAccountSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid account name.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const account = await renameCodexAccount(
      decodeURIComponent(c.req.param("accountId")),
      parseResult.data.alias,
    )
    return c.json({ success: true, account })
  } catch (error) {
    return await forwardError(c, error)
  }
})

// Probe Codex/ChatGPT account capabilities (Sol, Extra High, Pro, etc.)
configRoutes.post(
  "/codex/accounts/:accountId/probe-capabilities",
  async (c) => {
    try {
      const accountId = decodeURIComponent(c.req.param("accountId"))
      const store = await readCodexCredentialStore()
      if (!store || store.accounts.length === 0) {
        return c.json(
          { error: { message: "No Codex accounts found", type: "not_found" } },
          404,
        )
      }
      const account = store.accounts.find((a) => a.accountId === accountId)
      if (!account) {
        return c.json(
          {
            error: {
              message: `Account ${accountId} not found`,
              type: "not_found",
            },
          },
          404,
        )
      }

      const { probeCodexCapabilities } = await import(
        "~/lib/codex-capabilities"
      )
      const capabilities = await probeCodexCapabilities({
        accessToken: account.accessToken,
        accountId: account.accountId,
      })

      // Persist capabilities
      await updateCodexAccountCapabilities(accountId, capabilities)

      return c.json({ success: true, accountId, capabilities })
    } catch (error) {
      return await forwardError(c, error)
    }
  },
)

// Probe capabilities for all Codex accounts
configRoutes.post("/codex/accounts/probe-all-capabilities", async (c) => {
  try {
    const store = await readCodexCredentialStore()
    if (!store || store.accounts.length === 0) {
      return c.json({ success: true, probed: 0, results: [] })
    }

    const { probeCodexCapabilities } = await import("~/lib/codex-capabilities")

    const results = []
    for (const account of store.accounts) {
      try {
        const capabilities = await probeCodexCapabilities({
          accessToken: account.accessToken,
          accountId: account.accountId,
        })
        await updateCodexAccountCapabilities(account.accountId, capabilities)
        results.push({
          accountId: account.accountId,
          success: true,
          capabilities,
        })
      } catch (error) {
        results.push({
          accountId: account.accountId,
          success: false,
          error: String(error),
        })
      }
    }

    return c.json({ success: true, probed: results.length, results })
  } catch (error) {
    return await forwardError(c, error)
  }
})

// Claude subscription sign-in is implemented inside the gateway. The
// dashboard opens the authorize URL and the user pastes the code back, so a
// headless server never needs to receive the browser callback. The gateway
// stores the OAuth token itself and refreshes it before expiry.
const claudeOAuthLogin = createClaudeOAuthLogin()

function claudeLoginErrorResponse(c: Context, error: unknown) {
  if (error instanceof ClaudeOAuthError) {
    return c.json(
      { error: { message: error.message, type: "invalid_request_error" } },
      400,
    )
  }
  return null
}

configRoutes.get("/auth/claude/status", async (c) => {
  try {
    const status = await claudeOAuthLogin.status()
    if (status.loggedIn) syncClaudeProviderConfig()
    return c.json({ success: true, ...status })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.post("/auth/claude/start", (c) => {
  try {
    return c.json(claudeOAuthLogin.start())
  } catch (error) {
    return (
      claudeLoginErrorResponse(c, error)
      ?? c.json(
        { error: { message: "Could not start the Claude sign-in." } },
        500,
      )
    )
  }
})

configRoutes.post("/auth/claude/complete", async (c) => {
  try {
    const body = await readJsonBody(c)
    const status = await claudeOAuthLogin.submit(body.flowId, body.code)
    if (status.loggedIn) syncClaudeProviderConfig()
    return c.json({ success: true, status })
  } catch (error) {
    return claudeLoginErrorResponse(c, error) ?? (await forwardError(c, error))
  }
})

configRoutes.delete("/auth/claude/login/:flowId", (c) => {
  return c.json({
    success: true,
    cancelled: claudeOAuthLogin.cancel(c.req.param("flowId")),
  })
})

configRoutes.post("/auth/claude/logout", async (c) => {
  try {
    return c.json({
      success: true,
      status: await claudeOAuthLogin.logout(),
    })
  } catch (error) {
    return claudeLoginErrorResponse(c, error) ?? (await forwardError(c, error))
  }
})

// Anthropic API key management
configRoutes.get("/anthropic/apikey", async (c) => {
  try {
    // Never send the stored secret back to the browser.
    const config = readEditableConfigFromDisk()
    return c.json({ configured: Boolean(config.anthropicApiKey?.trim()) })
  } catch (error) {
    return await forwardError(c, error)
  }
})

const setAnthropicApiKeySchema = z.object({
  apiKey: z.string().min(1),
})

configRoutes.post("/anthropic/apikey", async (c) => {
  try {
    const parseResult = setAnthropicApiKeySchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const { apiKey } = parseResult.data
    const config = readEditableConfigFromDisk()
    writeConfigToDisk({
      ...config,
      anthropicApiKey: apiKey.trim(),
    })
    await reloadServerConfig()
    return c.json({ success: true })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.delete("/anthropic/apikey", async (c) => {
  try {
    const config = readEditableConfigFromDisk()
    writeConfigToDisk({
      ...config,
      anthropicApiKey: undefined,
    })
    await reloadServerConfig()
    return c.json({ success: true })
  } catch (error) {
    return await forwardError(c, error)
  }
})
