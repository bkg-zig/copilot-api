import { randomUUID } from "node:crypto"

import type { GitHubIdentity } from "~/lib/github-accounts"
import type { DeviceCodeResponse } from "~/services/github/get-device-code"

import { HTTPError } from "~/lib/error"
import { readGitHubErrorMessage } from "~/lib/github-error-message"

/**
 * GitHub sign-in from the dashboard with a device code (RFC 8628), the same
 * grant the `copilot-api auth` command uses. The dashboard shows a short code,
 * the user confirms it at github.com/login/device, and the server polls in the
 * background until GitHub issues the token. Before the account is saved the
 * server checks that the token really reaches Copilot.
 */

export const GITHUB_DEVICE_VERIFICATION_URL = "https://github.com/login/device"

const MAX_FLOW_MS = 15 * 60 * 1000
const FINISHED_RETENTION_MS = 10 * 60 * 1000
// Lets the poller report "expired" itself before the hard stop below.
const DEADLINE_GRACE_MS = 30_000
const MAX_ACTIVE_FLOWS = 5

const EXPIRED_MESSAGE = "The code expired. Start the sign-in again."

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined

export type GitHubDeviceFlowStatus =
  | {
      flowId: string
      status: "pending"
      userCode: string
      verificationUrl: string
      expiresAt: number
    }
  | {
      flowId: string
      status: "succeeded"
      accountId: string
      login: string
      alias?: string
    }
  | { flowId: string; status: "failed"; error: string }
  | { flowId: string; status: "cancelled" }

export class GitHubDeviceLoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitHubDeviceLoginError"
  }
}

export interface GitHubDeviceLoginDependencies {
  requestDeviceCode: (signal: AbortSignal) => Promise<DeviceCodeResponse>
  pollToken: (
    device: DeviceCodeResponse,
    signal: AbortSignal,
  ) => Promise<string>
  /** Resolves the token's owner and confirms it can use Copilot. */
  identify: (token: string, signal: AbortSignal) => Promise<GitHubIdentity>
  persist: (
    account: GitHubIdentity & { token: string },
    alias: string | undefined,
  ) => Promise<void>
  now: () => number
}

interface Flow {
  status: GitHubDeviceFlowStatus
  controller: AbortController
  finishedAt?: number
}

const loginMessage = (error: unknown): string =>
  error instanceof GitHubDeviceLoginError ?
    error.message
  : "Sign-in failed. Try again."

// Only an https link may reach the dashboard, never a javascript: URL.
function safeVerificationUrl(raw: unknown): string {
  if (typeof raw !== "string") return GITHUB_DEVICE_VERIFICATION_URL
  try {
    const url = new URL(raw)
    return url.protocol === "https:" ?
        url.toString()
      : GITHUB_DEVICE_VERIFICATION_URL
  } catch {
    return GITHUB_DEVICE_VERIFICATION_URL
  }
}

function flowLifetimeMs(expiresIn: unknown): number {
  return (
      typeof expiresIn === "number"
        && Number.isFinite(expiresIn)
        && expiresIn > 0
    ) ?
      Math.min(MAX_FLOW_MS, expiresIn * 1000)
    : MAX_FLOW_MS
}

export function createGitHubDeviceLogin(deps: GitHubDeviceLoginDependencies) {
  const flows = new Map<string, Flow>()

  function prune(): void {
    const now = deps.now()
    for (const [id, flow] of flows) {
      if (
        flow.finishedAt !== undefined
        && now - flow.finishedAt > FINISHED_RETENTION_MS
      ) {
        flows.delete(id)
      }
    }
  }

  function finish(flow: Flow, status: GitHubDeviceFlowStatus): void {
    if (flow.finishedAt !== undefined) return
    flow.status = status
    flow.finishedAt = deps.now()
  }

  async function run(
    flow: Flow,
    device: DeviceCodeResponse,
    lifetimeMs: number,
    alias: string | undefined,
  ): Promise<void> {
    const { flowId } = flow.status
    const deadline = AbortSignal.timeout(lifetimeMs + DEADLINE_GRACE_MS)
    const signal = AbortSignal.any([flow.controller.signal, deadline])
    try {
      const token = await deps.pollToken(device, signal)
      const identity = await deps.identify(token, signal)
      // A cancel that arrives while GitHub answers must not save the account.
      signal.throwIfAborted()
      await deps.persist({ ...identity, token }, alias)
      finish(flow, {
        flowId,
        status: "succeeded",
        accountId: identity.accountId,
        login: identity.login,
        ...(alias ? { alias } : {}),
      })
    } catch (error) {
      if (flow.controller.signal.aborted) {
        finish(flow, { flowId, status: "cancelled" })
        return
      }
      finish(flow, {
        flowId,
        status: "failed",
        error: deadline.aborted ? EXPIRED_MESSAGE : loginMessage(error),
      })
    }
  }

  async function start(alias?: string): Promise<GitHubDeviceFlowStatus> {
    prune()
    const active = [...flows.values()].filter(
      (flow) => flow.status.status === "pending",
    )
    if (active.length >= MAX_ACTIVE_FLOWS) {
      throw new GitHubDeviceLoginError(
        "Too many sign-ins in progress. Finish or cancel one first.",
      )
    }
    const controller = new AbortController()
    let device: DeviceCodeResponse
    try {
      device = await deps.requestDeviceCode(controller.signal)
    } catch (error) {
      throw error instanceof GitHubDeviceLoginError ? error : (
          new GitHubDeviceLoginError(
            error instanceof HTTPError ?
              `GitHub did not issue a sign-in code (HTTP ${error.response.status}).`
            : "GitHub is not reachable. Try again.",
          )
        )
    }
    if (!text(device.device_code) || !text(device.user_code)) {
      throw new GitHubDeviceLoginError("GitHub sent an incomplete answer.")
    }
    const lifetimeMs = flowLifetimeMs(device.expires_in)
    const flowId = randomUUID()
    const flow: Flow = {
      controller,
      status: {
        flowId,
        status: "pending",
        userCode: device.user_code,
        verificationUrl: safeVerificationUrl(device.verification_uri),
        expiresAt: deps.now() + lifetimeMs,
      },
    }
    flows.set(flowId, flow)
    void run(flow, device, lifetimeMs, alias)
    return flow.status
  }

  function status(flowId: string): GitHubDeviceFlowStatus | null {
    prune()
    return flows.get(flowId)?.status ?? null
  }

  function cancel(flowId: string): GitHubDeviceFlowStatus | null {
    const flow = flows.get(flowId)
    if (!flow) return null
    if (flow.status.status === "pending") {
      finish(flow, { flowId, status: "cancelled" })
      flow.controller.abort()
    }
    return flow.status
  }

  function hasPending(): boolean {
    return [...flows.values()].some((flow) => flow.status.status === "pending")
  }

  return { start, status, cancel, hasPending }
}

/** Turns the poller's errors into messages the dashboard can show. */
export function toGitHubPollError(error: unknown): Error {
  const message = error instanceof Error ? error.message : ""
  if (message.includes("expired")) {
    return new GitHubDeviceLoginError(EXPIRED_MESSAGE)
  }
  if (message.startsWith("GitHub device authorization failed")) {
    return new GitHubDeviceLoginError(
      "GitHub refused the sign-in. Start it again.",
    )
  }
  return error instanceof Error ? error : new Error(String(error))
}

export interface GitHubIdentityApi {
  getUser: (
    token: string,
    signal: AbortSignal,
  ) => Promise<{ id?: unknown; login?: unknown }>
  /**
   * Asks GitHub for a Copilot token, the same exchange Copilot needs to run.
   * It rejects with an HTTPError when the account cannot use Copilot, for
   * example while its billing is locked. `/copilot_internal/user` still
   * answers for such an account, so it proves nothing.
   */
  getCopilotToken: (token: string, signal: AbortSignal) => Promise<unknown>
}

const COPILOT_DENIED_STATUSES = new Set([401, 403, 404])

async function copilotCheckError(
  error: HTTPError,
  login: string,
): Promise<GitHubDeviceLoginError> {
  const { status } = error.response
  const denied = COPILOT_DENIED_STATUSES.has(status)
  const reason = await readGitHubErrorMessage(error)
  const advice =
    reason ? `GitHub says: ${reason}`
    : denied ? "Check its Copilot plan."
    : "Try again."
  return new GitHubDeviceLoginError(
    denied ?
      `GitHub account ${login} cannot use Copilot. ${advice}`
    : `Copilot check failed (HTTP ${status}). ${advice}`,
  )
}

/** Reads the token's GitHub account and confirms Copilot issues a token. */
export async function identifyGitHubCopilotAccount(
  token: string,
  signal: AbortSignal,
  api: GitHubIdentityApi,
): Promise<GitHubIdentity> {
  let user: { id?: unknown; login?: unknown }
  try {
    user = await api.getUser(token, signal)
  } catch (error) {
    if (signal.aborted) throw error
    throw new GitHubDeviceLoginError(
      error instanceof HTTPError ?
        `GitHub did not accept the new sign-in (HTTP ${error.response.status}).`
      : "GitHub is not reachable. Try again.",
    )
  }
  const accountId =
    typeof user.id === "number" && Number.isSafeInteger(user.id) ?
      String(user.id)
    : text(user.id)
  const login = text(user.login)
  if (!accountId || !login) {
    throw new GitHubDeviceLoginError("GitHub sent an incomplete answer.")
  }
  try {
    await api.getCopilotToken(token, signal)
  } catch (error) {
    if (signal.aborted) throw error
    throw error instanceof HTTPError ?
        await copilotCheckError(error, login)
      : new GitHubDeviceLoginError("GitHub is not reachable. Try again.")
  }
  return { accountId, login }
}
