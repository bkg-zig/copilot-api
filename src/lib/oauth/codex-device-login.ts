import { randomUUID } from "node:crypto"

import type { CodexCredentials } from "./codex"

/**
 * Codex sign-in with a device code — the headless-friendly way, the same grant
 * as `codex login --device-auth`. The dashboard shows a short code, the user
 * confirms it on OpenAI's page, and the server polls until OpenAI hands out an
 * authorization code plus the PKCE verifier it generated itself. That pair is
 * exchanged at the normal token endpoint. No redirect address to copy.
 *
 * Unlike RFC 8628, "still waiting" is signalled with HTTP 403/404; every other
 * non-2xx answer ends the flow.
 */

export const CODEX_DEVICE_VERIFICATION_URL =
  "https://auth.openai.com/codex/device"
export const CODEX_DEVICE_REDIRECT_URI =
  "https://auth.openai.com/deviceauth/callback"
const USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode"
const POLL_URL = "https://auth.openai.com/api/accounts/deviceauth/token"

const FLOW_TTL_MS = 15 * 60 * 1000
const FINISHED_RETENTION_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_INTERVAL_MS = 5_000
const MIN_INTERVAL_MS = 1_000
const MAX_ACTIVE_FLOWS = 5

export type CodexDeviceFlowStatus =
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

export class CodexDeviceLoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodexDeviceLoginError"
  }
}

export interface CodexDeviceLoginDependencies {
  clientId: string
  fetch: (input: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  now: () => number
  exchange: (grant: {
    code: string
    verifier: string
    redirectUri: string
  }) => Promise<CodexCredentials>
  persist: (
    credentials: CodexCredentials,
    alias: string | undefined,
  ) => Promise<void>
}

interface Flow {
  status: CodexDeviceFlowStatus
  controller: AbortController
  finishedAt?: number
}

/** Upstream sends `interval` in seconds, sometimes as a string. */
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

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CodexDeviceLoginError("Sign-in cancelled."))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new CodexDeviceLoginError("Sign-in cancelled."))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export function createCodexDeviceLogin(deps: CodexDeviceLoginDependencies) {
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

  function finish(flow: Flow, status: CodexDeviceFlowStatus): void {
    flow.status = status
    flow.finishedAt = deps.now()
  }

  async function poll(
    flow: Flow,
    device: {
      deviceAuthId: string
      userCode: string
      intervalMs: number
      deadline: number
    },
    alias: string | undefined,
  ): Promise<void> {
    const { flowId } = flow.status
    const signal = flow.controller.signal
    try {
      while (deps.now() < device.deadline) {
        const response = await deps.fetch(POLL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_auth_id: device.deviceAuthId,
            user_code: device.userCode,
          }),
          signal: requestSignal(signal),
        })
        if (response.status === 403 || response.status === 404) {
          await deps.sleep(
            Math.min(
              device.intervalMs,
              Math.max(0, device.deadline - deps.now()),
            ),
            signal,
          )
          continue
        }
        if (!response.ok) {
          throw new CodexDeviceLoginError(
            `OpenAI rejected the sign-in (HTTP ${response.status}).`,
          )
        }
        const payload = (await response.json()) as Record<string, unknown>
        const code = text(payload.authorization_code)
        const verifier = text(payload.code_verifier)
        if (!code || !verifier) {
          throw new CodexDeviceLoginError("OpenAI sent an incomplete answer.")
        }
        const credentials = await deps.exchange({
          code,
          verifier,
          redirectUri: CODEX_DEVICE_REDIRECT_URI,
        })
        await deps.persist(credentials, alias)
        finish(flow, {
          flowId,
          status: "succeeded",
          accountId: credentials.accountId,
          alias,
        })
        return
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
      finish(flow, {
        flowId,
        status: "failed",
        error:
          error instanceof CodexDeviceLoginError ?
            error.message
          : "Sign-in failed. Try again.",
      })
    }
  }

  async function start(alias?: string): Promise<CodexDeviceFlowStatus> {
    prune()
    const active = [...flows.values()].filter(
      (flow) => flow.status.status === "pending",
    )
    if (active.length >= MAX_ACTIVE_FLOWS) {
      throw new CodexDeviceLoginError(
        "Too many sign-ins in progress. Finish or cancel one first.",
      )
    }
    const controller = new AbortController()
    const response = await deps.fetch(USERCODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: deps.clientId }),
      signal: requestSignal(controller.signal),
    })
    if (!response.ok) {
      throw new CodexDeviceLoginError(
        `OpenAI did not issue a device code (HTTP ${response.status}). Device code sign-in may be turned off for this ChatGPT account.`,
      )
    }
    const payload = (await response.json()) as Record<string, unknown>
    const deviceAuthId = text(payload.device_auth_id)
    const userCode = text(payload.user_code) ?? text(payload.usercode)
    if (!deviceAuthId || !userCode) {
      throw new CodexDeviceLoginError("OpenAI sent an incomplete answer.")
    }
    const expiresAt = deps.now() + FLOW_TTL_MS
    const flowId = randomUUID()
    const flow: Flow = {
      controller,
      status: {
        flowId,
        status: "pending",
        userCode,
        verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
        expiresAt,
      },
    }
    flows.set(flowId, flow)
    void poll(
      flow,
      {
        deviceAuthId,
        userCode,
        intervalMs: toIntervalMs(payload.interval),
        deadline: expiresAt,
      },
      alias,
    )
    return flow.status
  }

  function status(flowId: string): CodexDeviceFlowStatus | null {
    prune()
    return flows.get(flowId)?.status ?? null
  }

  function cancel(flowId: string): CodexDeviceFlowStatus | null {
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
