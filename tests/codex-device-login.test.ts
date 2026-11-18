import { describe, expect, test } from "bun:test"

import type { CodexCredentials } from "~/lib/oauth/codex"

import {
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_VERIFICATION_URL,
  CodexDeviceLoginError,
  createCodexDeviceLogin,
  defaultSleep,
  type CodexDeviceFlowStatus,
} from "~/lib/oauth/codex-device-login"

const credentials: CodexCredentials = {
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: 1,
  accountId: "acct-1",
}

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status })

interface Harness {
  login: ReturnType<typeof createCodexDeviceLogin>
  calls: Array<{ url: string; body: unknown }>
  sleeps: Array<number>
  persisted: Array<{ credentials: CodexCredentials; alias?: string }>
  exchanged: Array<{ code: string; verifier: string; redirectUri: string }>
  clock: { now: number }
}

function harness(
  responses: Array<Response | Error>,
  options: {
    exchange?: () => Promise<CodexCredentials>
    sleepAdvanceMs?: number
  } = {},
): Harness {
  const clock = { now: 1_000_000 }
  const calls: Harness["calls"] = []
  const sleeps: Array<number> = []
  const persisted: Harness["persisted"] = []
  const exchanged: Harness["exchanged"] = []
  const login = createCodexDeviceLogin({
    clientId: "client",
    now: () => clock.now,
    fetch: (url, init) => {
      calls.push({ url, body: JSON.parse(init.body as string) })
      const next = responses.shift()
      if (!next) return Promise.reject(new Error("no more responses"))
      return next instanceof Error ?
          Promise.reject(next)
        : Promise.resolve(next)
    },
    sleep: (ms, signal) => {
      sleeps.push(ms)
      clock.now += options.sleepAdvanceMs ?? ms
      return signal.aborted ?
          Promise.reject(new CodexDeviceLoginError("Sign-in cancelled."))
        : Promise.resolve()
    },
    exchange: (grant) => {
      exchanged.push(grant)
      return options.exchange ?
          options.exchange()
        : Promise.resolve(credentials)
    },
    persist: (creds, alias) => {
      persisted.push({ credentials: creds, alias })
      return Promise.resolve()
    },
  })
  return { login, calls, sleeps, persisted, exchanged, clock }
}

async function settle(
  h: Harness,
  flowId: string,
): Promise<CodexDeviceFlowStatus | null> {
  for (let i = 0; i < 50; i++) {
    const status = h.login.status(flowId)
    if (status?.status !== "pending") return status
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return h.login.status(flowId)
}

const issued = (extra: Record<string, unknown> = {}) =>
  json(200, { device_auth_id: "dev-1", user_code: "ABCD-1234", ...extra })

describe("codex device login", () => {
  test("polls until approved, exchanges and persists", async () => {
    const h = harness([
      issued({ interval: "2" }),
      json(403),
      json(404),
      json(200, { authorization_code: "code-1", code_verifier: "ver-1" }),
    ])
    const started = await h.login.start("work")
    expect(started).toMatchObject({
      status: "pending",
      userCode: "ABCD-1234",
      verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
    })
    expect(h.calls[0]?.body).toEqual({ client_id: "client" })

    const final = await settle(h, started.flowId)
    expect(final).toEqual({
      flowId: started.flowId,
      status: "succeeded",
      accountId: "acct-1",
      alias: "work",
    })
    expect(h.sleeps).toEqual([2000, 2000])
    expect(h.calls[1]?.body).toEqual({
      device_auth_id: "dev-1",
      user_code: "ABCD-1234",
    })
    expect(h.exchanged).toEqual([
      {
        code: "code-1",
        verifier: "ver-1",
        redirectUri: CODEX_DEVICE_REDIRECT_URI,
      },
    ])
    expect(h.persisted).toEqual([{ credentials, alias: "work" }])
  })

  test("accepts the legacy usercode field and clamps the interval", async () => {
    const h = harness([
      json(200, { device_auth_id: "dev", usercode: "X", interval: 0.01 }),
      json(403),
      json(200, { authorization_code: "c", code_verifier: "v" }),
    ])
    const started = await h.login.start()
    expect(started).toMatchObject({ userCode: "X" })
    await settle(h, started.flowId)
    expect(h.sleeps).toEqual([1000])
  })

  test("uses the default interval for junk values", async () => {
    const h = harness([
      issued({ interval: "soon" }),
      json(404),
      json(200, { authorization_code: "c", code_verifier: "v" }),
    ])
    const started = await h.login.start()
    await settle(h, started.flowId)
    expect(h.sleeps).toEqual([5000])
  })

  test("rejects when no device code is issued", () => {
    const h = harness([json(429)])
    expect(h.login.start()).rejects.toThrow(/HTTP 429/)
  })

  test("rejects an incomplete device code answer", () => {
    const h = harness([json(200, { device_auth_id: "dev" })])
    expect(h.login.start()).rejects.toBeInstanceOf(CodexDeviceLoginError)
  })

  test("fails on an unexpected poll status without echoing the body", async () => {
    const h = harness([issued(), json(500, { secret: "nope" })])
    const started = await h.login.start()
    const final = await settle(h, started.flowId)
    expect(final).toMatchObject({ status: "failed" })
    expect(JSON.stringify(final)).toContain("HTTP 500")
    expect(JSON.stringify(final)).not.toContain("nope")
  })

  test("fails on an incomplete grant", async () => {
    const h = harness([issued(), json(200, { authorization_code: "c" })])
    const started = await h.login.start()
    expect(await settle(h, started.flowId)).toMatchObject({
      status: "failed",
      error: "OpenAI sent an incomplete answer.",
    })
  })

  test("hides unexpected internal errors", async () => {
    const h = harness(
      [issued(), json(200, { authorization_code: "c", code_verifier: "v" })],
      { exchange: () => Promise.reject(new Error("token=leaky")) },
    )
    const started = await h.login.start()
    const final = await settle(h, started.flowId)
    expect(final).toMatchObject({
      status: "failed",
      error: "Sign-in failed. Try again.",
    })
    expect(h.persisted).toEqual([])
  })

  test("expires after the flow lifetime", async () => {
    const h = harness([issued(), json(403), json(403), json(403)], {
      sleepAdvanceMs: 10 * 60 * 1000,
    })
    const started = await h.login.start()
    expect(await settle(h, started.flowId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("expired") as unknown as string,
    })
  })

  test("cancel stops a pending flow; unknown ids return null", async () => {
    const login = createCodexDeviceLogin({
      clientId: "client",
      now: () => 0,
      fetch: (url, init) =>
        url.endsWith("/usercode") ?
          Promise.resolve(issued())
        : new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"))
            })
          }),
      sleep: () => Promise.resolve(),
      exchange: () => Promise.resolve(credentials),
      persist: () => Promise.resolve(),
    })
    const h = { login } as Harness
    const started = await h.login.start()
    expect(h.login.cancel(started.flowId)).toEqual({
      flowId: started.flowId,
      status: "cancelled",
    })
    expect(await settle(h, started.flowId)).toMatchObject({
      status: "cancelled",
    })
    // A second cancel keeps the terminal state.
    expect(h.login.cancel(started.flowId)).toMatchObject({
      status: "cancelled",
    })
    expect(h.login.cancel("missing")).toBeNull()
    expect(h.login.status("missing")).toBeNull()
  })

  test("forgets finished flows after the retention period", async () => {
    const h = harness([issued()])
    const started = await h.login.start()
    expect(await settle(h, started.flowId)).toMatchObject({ status: "failed" })
    h.clock.now += 11 * 60 * 1000
    expect(h.login.status(started.flowId)).toBeNull()
  })

  test("refuses a sixth parallel flow", async () => {
    const never = new Promise<Response>(() => {})
    let issuedCount = 0
    const login = createCodexDeviceLogin({
      clientId: "client",
      now: () => 0,
      fetch: (url) => {
        if (url.endsWith("/usercode")) {
          issuedCount++
          return Promise.resolve(issued())
        }
        return never
      },
      sleep: () => Promise.resolve(),
      exchange: () => Promise.resolve(credentials),
      persist: () => Promise.resolve(),
    })
    for (let i = 0; i < 5; i++) await login.start()
    expect(login.start()).rejects.toThrow(/Too many/)
    expect(issuedCount).toBe(5)
  })
})

describe("defaultSleep", () => {
  test("resolves after the delay", async () => {
    const controller = new AbortController()
    await defaultSleep(1, controller.signal)
  })

  test("rejects when already aborted", () => {
    const controller = new AbortController()
    controller.abort()
    expect(defaultSleep(1000, controller.signal)).rejects.toThrow(/cancelled/)
  })

  test("rejects when aborted while waiting", () => {
    const controller = new AbortController()
    const pending = defaultSleep(60_000, controller.signal)
    controller.abort()
    expect(pending).rejects.toThrow(/cancelled/)
  })
})
