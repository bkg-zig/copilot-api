import consola from "consola"
import { Hono, type Context } from "hono"
import { z } from "zod"

import { reloadServerConfig } from "~/lib/config-reload"
import { getConfig, type AppConfig } from "~/lib/config-store"
import { readGitHubTokenFromEnv } from "~/lib/credential-store"
import { forwardError } from "~/lib/error"
import {
  createDefaultGitHubAccountManager,
  GitHubAccountError,
  MAX_GITHUB_ACCOUNTS,
  normalizeGitHubAccountAlias,
  type GitHubAccountManager,
} from "~/lib/github-accounts"
import {
  GITHUB_COPILOT_PROVIDER,
  isGitHubCopilotAvailable,
  isGitHubCopilotEnabled,
} from "~/lib/github-copilot-provider"
import {
  createGitHubDeviceLogin,
  GitHubDeviceLoginError,
  identifyGitHubCopilotAccount,
  toGitHubPollError,
} from "~/lib/oauth/github-device-login"
import { saveProviderManagementConfig } from "~/lib/provider-management"
import { state, type State } from "~/lib/state"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import {
  getDeviceCode,
  type DeviceCodeResponse,
} from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

const REQUEST_TIMEOUT_MS = 30_000
const LOOKUP_TIMEOUT_MS = 10_000

export interface CopilotStatus {
  enabled: boolean
  /** Copilot has a working token; false while for example billing is locked. */
  running: boolean
  /** Why the last start failed, in GitHub's words where possible. */
  error?: string
}

/** Copilot's state for the dashboard, with the reason when it is not running. */
export function readCopilotStatus(
  config: AppConfig = getConfig(),
  runtime: Pick<
    State,
    "githubToken" | "copilotToken" | "copilotSetupError"
  > = state,
): CopilotStatus {
  const running = isGitHubCopilotAvailable(config, runtime)
  const error = running ? undefined : runtime.copilotSetupError
  return {
    enabled: isGitHubCopilotEnabled(config),
    running,
    ...(error ? { error } : {}),
  }
}

export interface GitHubAuthRouteDependencies {
  accounts: GitHubAccountManager
  deviceLogin: Pick<
    ReturnType<typeof createGitHubDeviceLogin>,
    "start" | "status" | "cancel"
  >
  /** Turns the github-copilot provider on or off in config.json. */
  setCopilotEnabled: (enabled: boolean) => void
  reload: () => Promise<void>
  copilotStatus: () => CopilotStatus
}

const accountIdSchema = z.object({ accountId: z.string().trim().min(1) })

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

const invalidRequest = (c: Context, message: string) =>
  c.json({ error: { message, type: "invalid_request_error" } }, 400)

const notFound = (c: Context) =>
  c.json({ error: { message: "Sign-in not found.", type: "not_found" } }, 404)

async function errorResponse(c: Context, error: unknown): Promise<Response> {
  if (error instanceof GitHubAccountError) {
    return c.json(
      {
        error: {
          message: error.message,
          type: error.status === 404 ? "not_found" : "invalid_request_error",
        },
      },
      error.status,
    )
  }
  if (error instanceof GitHubDeviceLoginError) {
    return invalidRequest(c, error.message)
  }
  return await forwardError(c, error)
}

export function createGitHubAuthRoutes(deps: GitHubAuthRouteDependencies) {
  const routes = new Hono()

  // A failed hot reload must not fail an admin write that was already saved.
  const reloadQuietly = async (): Promise<void> => {
    try {
      await deps.reload()
    } catch (error) {
      consola.warn("Reload after a GitHub account change failed:", error)
    }
  }

  routes.post("/auth/github/device/start", async (c) => {
    try {
      const body = await readJsonBody(c)
      const alias =
        body.alias === undefined || body.alias === null || body.alias === "" ?
          undefined
        : normalizeGitHubAccountAlias(body.alias)
      if ((await deps.accounts.count()) >= MAX_GITHUB_ACCOUNTS) {
        throw new GitHubAccountError(
          `Up to ${MAX_GITHUB_ACCOUNTS} GitHub accounts. Remove one first.`,
          409,
        )
      }
      return c.json(await deps.deviceLogin.start(alias))
    } catch (error) {
      return await errorResponse(c, error)
    }
  })

  routes.get("/auth/github/device/:flowId", (c) => {
    const status = deps.deviceLogin.status(c.req.param("flowId"))
    return status ? c.json(status) : notFound(c)
  })

  routes.delete("/auth/github/device/:flowId", (c) => {
    const status = deps.deviceLogin.cancel(c.req.param("flowId"))
    return status ? c.json(status) : notFound(c)
  })

  routes.get("/github/accounts", async (c) => {
    try {
      return c.json({
        ...(await deps.accounts.list()),
        maxAccounts: MAX_GITHUB_ACCOUNTS,
        copilot: deps.copilotStatus(),
      })
    } catch (error) {
      return await errorResponse(c, error)
    }
  })

  routes.post("/github/accounts/select", async (c) => {
    try {
      const parsed = accountIdSchema.safeParse(await readJsonBody(c))
      if (!parsed.success) return invalidRequest(c, "accountId is required.")
      const account = await deps.accounts.select(parsed.data.accountId)
      deps.setCopilotEnabled(true)
      await reloadQuietly()
      // The switch is saved either way; the status says whether Copilot
      // really runs with the account, for example not with locked billing.
      return c.json({ success: true, account, copilot: deps.copilotStatus() })
    } catch (error) {
      return await errorResponse(c, error)
    }
  })

  routes.post("/github/accounts/remove", async (c) => {
    try {
      const parsed = accountIdSchema.safeParse(await readJsonBody(c))
      if (!parsed.success) return invalidRequest(c, "accountId is required.")
      const { account, wasActive } = await deps.accounts.remove(
        parsed.data.accountId,
      )
      if (wasActive) {
        // The account in use was the last one, so Copilot is signed out. A
        // token handed to the server at start keeps working; Copilot stays on.
        if (!deps.accounts.hasTokenOverride()) deps.setCopilotEnabled(false)
        await reloadQuietly()
      }
      return c.json({ success: true, account })
    } catch (error) {
      return await errorResponse(c, error)
    }
  })

  routes.patch("/github/accounts/:accountId", async (c) => {
    try {
      const body = await readJsonBody(c)
      const account = await deps.accounts.rename(
        decodeURIComponent(c.req.param("accountId")),
        body.alias,
      )
      return c.json({ success: true, account })
    } catch (error) {
      return await errorResponse(c, error)
    }
  })

  return routes
}

const withTimeout = (signal: AbortSignal, ms: number): AbortSignal =>
  AbortSignal.any([signal, AbortSignal.timeout(ms)])

/** The outside calls behind the GitHub routes; replaced in tests. */
export interface GitHubAuthApi {
  getDeviceCode: (signal: AbortSignal) => Promise<DeviceCodeResponse>
  pollAccessToken: (
    device: DeviceCodeResponse,
    signal: AbortSignal,
  ) => Promise<string>
  getGitHubUser: (
    token: string,
    signal: AbortSignal,
  ) => Promise<{ id: number; login: string }>
  /**
   * Copilot token exchange for a new sign-in. It rejects when the account
   * cannot use Copilot, for example while its billing is locked.
   */
  getCopilotToken: (token: string, signal: AbortSignal) => Promise<unknown>
  setCopilotEnabled: (enabled: boolean) => void
  reload: () => Promise<void>
  copilotStatus: () => CopilotStatus
  hasTokenOverride: () => boolean
  now: () => number
}

export function createGitHubAuthDependencies(
  api: GitHubAuthApi,
  createAccounts: typeof createDefaultGitHubAccountManager = createDefaultGitHubAccountManager,
): GitHubAuthRouteDependencies {
  const accounts = createAccounts({
    hasTokenOverride: api.hasTokenOverride,
    lookupIdentity: async (token) => {
      const user = await api.getGitHubUser(
        token,
        AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      )
      return { accountId: String(user.id), login: user.login }
    },
  })

  const deviceLogin = createGitHubDeviceLogin({
    requestDeviceCode: (signal) =>
      api.getDeviceCode(withTimeout(signal, REQUEST_TIMEOUT_MS)),
    pollToken: async (device, signal) => {
      try {
        return await api.pollAccessToken(device, signal)
      } catch (error) {
        if (signal.aborted) throw error
        throw toGitHubPollError(error)
      }
    },
    identify: (token, signal) =>
      identifyGitHubCopilotAccount(token, signal, {
        getUser: (userToken, userSignal) =>
          api.getGitHubUser(
            userToken,
            withTimeout(userSignal, REQUEST_TIMEOUT_MS),
          ),
        getCopilotToken: (userToken, userSignal) =>
          api.getCopilotToken(
            userToken,
            withTimeout(userSignal, REQUEST_TIMEOUT_MS),
          ),
      }),
    persist: async (account, alias) => {
      await accounts.add(account, alias)
      api.setCopilotEnabled(true)
      let reloaded = true
      try {
        await api.reload()
      } catch (error) {
        reloaded = false
        consola.warn("GitHub account saved, but Copilot did not start:", error)
      }
      // A reload keeps going while other providers are enabled, so the
      // runtime status, not the reload, tells whether Copilot really started.
      const copilot = api.copilotStatus()
      if (!reloaded || !copilot.running) {
        throw new GitHubDeviceLoginError(
          copilot.error ?
            `Account saved, but Copilot did not start: ${copilot.error}`
          : "Account saved, but Copilot did not start. Check the server log.",
        )
      }
    },
    now: api.now,
  })

  return {
    accounts,
    deviceLogin,
    setCopilotEnabled: api.setCopilotEnabled,
    reload: api.reload,
    copilotStatus: api.copilotStatus,
  }
}

function setCopilotEnabled(enabled: boolean): void {
  saveProviderManagementConfig({
    providers: { [GITHUB_COPILOT_PROVIDER]: { enabled } },
  })
}

// Lazy wrappers: referencing the upstream functions only at request time
// keeps module evaluation free of imported bindings, so a bundling or
// circular-import slip degrades to a handled route error instead of a
// ReferenceError that kills the whole server at startup.
export const githubAuthRoutes = createGitHubAuthRoutes(
  createGitHubAuthDependencies({
    getDeviceCode: (signal) => getDeviceCode(signal),
    pollAccessToken: (device, signal) =>
      pollAccessToken(device, undefined, { signal }),
    getGitHubUser: (token, signal) => getGitHubUser(token, signal),
    getCopilotToken: (token, signal) => getCopilotToken(token, signal),
    setCopilotEnabled,
    reload: () => reloadServerConfig(),
    copilotStatus: () => readCopilotStatus(),
    hasTokenOverride: () =>
      Boolean(readGitHubTokenFromEnv()) || state.githubTokenSource === "cli",
    now: Date.now,
  }),
)
