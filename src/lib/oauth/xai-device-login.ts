import { randomUUID } from "node:crypto"

import type { XaiCredentials } from "./xai"
import { XaiOAuthError } from "./xai"

/**
 * xAI (Grok) subscription sign-in with a device code for headless servers.
 * Mirrors the Codex device-login flow shape used by the dashboard.
 */

export const XAI_DEVICE_VERIFICATION_URL = "https://auth.x.ai/device"
const ISSUER = "https://auth.x.ai/oauth2"
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"

const FLOW_TTL_MS = 15 * 60 * 1000
const FINISHED_RETENTION_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_INTERVAL_MS = 5_000
const MIN_INTERVAL_MS = 1_000
const MAX_ACTIVE_FLOWS = 5
const POLLING_SAFETY_MARGIN_MS = 3000

export type XaiDeviceFlowStatus =
  | {
      flowId: string
      status: "pending"
      userCode: string
      verificationUrl: string
      expiresAt: number
    }
  | { flowId: string; status: "succeeded"; accountId: string; alias?: string }
  | { flowId: string; status: "failed"; error: string }
  | { flowId: string; status: "cancelled" }

export class XaiDeviceLoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "XaiDeviceLoginError"
  }
}

export interface XaiDeviceLoginDependencies {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  now: () => number
  persist: (
    credentials: XaiCredentials,
    alias: string | undefined,
  ) => Promise<void>
}

interface Flow {
  status: XaiDeviceFlowStatus
  controller: AbortController
  finishedAt?: number
}

function toIntervalMs(raw: unknown): number {
  const seconds = typeof raw === "string" ? Number(raw) : raw
  if (
    typeof seconds !== "number"
    || !Number.isFinite(seconds)
    || seconds <= 0
  ) {
    return DEFAULT_INTERVAL_MS
  }
  return Math.min(
    FLOW_TTL_MS,
    Math.max(MIN_INTERVAL_MS, Math.round(seconds * 1000)),
  )
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function positiveSeconds(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback
}

function tokenAccountId(token: string | undefined): string | undefined {
  if (!token) return undefined
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    )
    const claims =
      (
        payload
        && typeof payload === "object"
        && typeof (payload as { sub?: unknown }).sub === "string"
      ) ?
        (payload as { sub: string }).sub.trim() || undefined
      : undefined
    return claims
  } catch {
    return undefined
  }
}

function tokenCredentials(tokens: {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}): Omit<XaiCredentials, "accountId"> {
  const refreshToken = tokens.refresh_token
  if (!refreshToken) {
    throw new XaiDeviceLoginError("xAI token response is missing refresh_token")
  }

  let expiresAt = Date.now() + positiveSeconds(tokens.expires_in, 3600) * 1000
  if (!tokens.expires_in || tokens.expires_in <= 0) {
    try {
      const payload: unknown = JSON.parse(
        Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(
          "utf8",
        ),
      )
      const exp =
        (
          payload
          && typeof payload === "object"
          && typeof (payload as { exp?: unknown }).exp === "number"
        ) ?
          (payload as { exp: number }).exp
        : undefined
      if (exp && Number.isFinite(exp) && exp > 0) expiresAt = exp * 1000
    } catch {
      // Opaque or malformed JWTs use a one-hour fallback lifetime.
    }
  }

  return { accessToken: tokens.access_token, refreshToken, expiresAt }
}

async function readOAuthError(response: Response): Promise<string | undefined> {
  const payload: unknown = await response.json().catch(() => null)
  if (!payload || typeof payload !== "object") return undefined
  const error = (payload as { error?: unknown }).error
  return typeof error === "string" ? error : undefined
}

function requestError(response: Response, error?: string): Error {
  const detail = error && /^[a-z_]+$/u.test(error) ? `: ${error}` : ""
  return new XaiDeviceLoginError(
    `xAI authorization request failed (${response.status})${detail}`,
  )
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new XaiDeviceLoginError("Sign-in cancelled."))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new XaiDeviceLoginError("Sign-in cancelled."))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function createXaiDeviceLogin(deps: XaiDeviceLoginDependencies) {
  const flows = new Map<string, Flow>()

  const requestSignal = (signal: AbortSignal): AbortSignal =>
    AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])

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

  function finish(flow: Flow, status: XaiDeviceFlowStatus): void {
    flow.status = status
    flow.finishedAt = deps.now()
  }

  async function sendToken(
    deviceCode: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return deps.fetch(`${ISSUER}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "copilot-api",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        device_code: deviceCode,
      }),
      signal: requestSignal(signal),
    })
  }

  async function resolveAccountId(
    tokens: { access_token: string; id_token?: string },
    signal: AbortSignal,
  ): Promise<string> {
    const accountId =
      tokenAccountId(tokens.id_token) ?? tokenAccountId(tokens.access_token)
    if (accountId) return accountId
    const response = await deps.fetch(`${ISSUER}/userinfo`, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/json",
      },
      signal: requestSignal(signal),
    })
    if (!response.ok)
      throw requestError(response, await readOAuthError(response))
    const payload = (await response.json()) as { sub?: unknown }
    const sub = typeof payload.sub === "string" ? payload.sub.trim() : ""
    if (!sub)
      throw new XaiDeviceLoginError("xAI userinfo response is missing sub")
    return sub
  }

  async function poll(
    flow: Flow,
    device: { deviceCode: string; intervalMs: number; deadline: number },
    alias: string | undefined,
  ): Promise<void> {
    const { flowId } = flow.status
    const signal = flow.controller.signal
    let intervalMs = device.intervalMs
    try {
      while (deps.now() < device.deadline) {
        const tokenResponse = await sendToken(device.deviceCode, signal)
        if (tokenResponse.ok) {
          const tokens = (await tokenResponse.json()) as {
            access_token?: unknown
            refresh_token?: unknown
            id_token?: unknown
            expires_in?: unknown
          }
          const accessToken = text(tokens.access_token)
          const refreshToken = text(tokens.refresh_token)
          if (!accessToken || !refreshToken) {
            throw new XaiDeviceLoginError(
              "xAI sent an incomplete token response.",
            )
          }
          const idToken = text(tokens.id_token)
          const expiresIn =
            (
              typeof tokens.expires_in === "number"
              && Number.isFinite(tokens.expires_in)
            ) ?
              tokens.expires_in
            : undefined
          const credentialsBase = tokenCredentials({
            access_token: accessToken,
            refresh_token: refreshToken,
            id_token: idToken,
            expires_in: expiresIn,
          })
          const accountId = await resolveAccountId(
            { access_token: accessToken, id_token: idToken },
            signal,
          )
          const credentials: XaiCredentials = { ...credentialsBase, accountId }
          await deps.persist(credentials, alias)
          finish(flow, { flowId, status: "succeeded", accountId, alias })
          return
        }

        const error = await readOAuthError(tokenResponse)
        if (error === "authorization_pending" || error === "slow_down") {
          if (error === "slow_down") intervalMs += 5000
          await deps.sleep(
            Math.min(
              intervalMs + POLLING_SAFETY_MARGIN_MS,
              Math.max(0, device.deadline - deps.now()),
            ),
            signal,
          )
          continue
        }
        if (error === "access_denied" || error === "authorization_denied") {
          throw new XaiDeviceLoginError("xAI device authorization was denied.")
        }
        if (error === "expired_token") {
          throw new XaiOAuthError("authorization_expired")
        }
        throw requestError(tokenResponse, error)
      }
      finish(flow, {
        flowId,
        status: "failed",
        error: "The code expired. Start the sign-in again.",
      })
    } catch (error) {
      if (signal.aborted) {
        finish(flow, { flowId, status: "cancelled" })
        return
      }
      if (
        error instanceof XaiOAuthError
        && error.reason === "authorization_expired"
      ) {
        finish(flow, {
          flowId,
          status: "failed",
          error: "The code expired. Start the sign-in again.",
        })
        return
      }
      finish(flow, {
        flowId,
        status: "failed",
        error:
          (
            error instanceof XaiDeviceLoginError
            || error instanceof XaiOAuthError
          ) ?
            error.message
          : "Sign-in failed. Try again.",
      })
    }
  }

  async function start(alias?: string): Promise<XaiDeviceFlowStatus> {
    prune()
    const active = [...flows.values()].filter(
      (flow) => flow.status.status === "pending",
    )
    if (active.length >= MAX_ACTIVE_FLOWS) {
      throw new XaiDeviceLoginError(
        "Too many sign-ins in progress. Finish or cancel one first.",
      )
    }
    const controller = new AbortController()
    const response = await deps.fetch(`${ISSUER}/device/code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "copilot-api",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        scope: SCOPE,
        referrer: "opencode",
      }),
      signal: requestSignal(controller.signal),
    })
    if (!response.ok) {
      throw requestError(response, await readOAuthError(response))
    }
    const payload = (await response.json()) as Record<string, unknown>
    const deviceCode = text(payload.device_code)
    const userCode = text(payload.user_code)
    const verificationUri =
      text(payload.verification_uri_complete)
      ?? text(payload.verification_uri)
      ?? XAI_DEVICE_VERIFICATION_URL
    if (!deviceCode || !userCode) {
      throw new XaiDeviceLoginError(
        "xAI sent an incomplete device code response.",
      )
    }
    const expiresAt =
      deps.now()
      + positiveSeconds(
        typeof payload.expires_in === "number" ? payload.expires_in : undefined,
        300,
      )
        * 1000
    const flowId = randomUUID()
    const flow: Flow = {
      controller,
      status: {
        flowId,
        status: "pending",
        userCode,
        verificationUrl: verificationUri,
        expiresAt,
      },
    }
    flows.set(flowId, flow)
    void poll(
      flow,
      {
        deviceCode,
        intervalMs: toIntervalMs(payload.interval),
        deadline: expiresAt,
      },
      alias,
    )
    return flow.status
  }

  function status(flowId: string): XaiDeviceFlowStatus | null {
    prune()
    return flows.get(flowId)?.status ?? null
  }

  function cancel(flowId: string): XaiDeviceFlowStatus | null {
    const flow = flows.get(flowId)
    if (!flow) return null
    if (flow.status.status === "pending") {
      flow.controller.abort()
      finish(flow, { flowId, status: "cancelled" })
    }
    return flow.status
  }

  return { start, status, cancel }
}
