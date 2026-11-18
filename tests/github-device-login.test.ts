import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import {
  createGitHubDeviceLogin,
  GITHUB_DEVICE_VERIFICATION_URL,
  GitHubDeviceLoginError,
  identifyGitHubCopilotAccount,
  toGitHubPollError,
  type GitHubDeviceLoginDependencies,
} from "~/lib/oauth/github-device-login"
import type { DeviceCodeResponse } from "~/services/github/get-device-code"

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject")
}

const device: DeviceCodeResponse = {
  device_code: "device-secret",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const httpError = (status: number) =>
  new HTTPError("GitHub failed", new Response("{}", { status }))

function setup(overrides: Partial<GitHubDeviceLoginDependencies> = {}) {
  const token = deferred<string>()
  const persisted: Array<{ account: unknown; alias: string | undefined }> = []
  let now = 1_000
  const login = createGitHubDeviceLogin({
    requestDeviceCode: () => Promise.resolve(device),
    pollToken: (_device, signal) => {
      signal.addEventListener("abort", () => token.reject(signal.reason), {
        once: true,
      })
      return token.promise
    },
    identify: () => Promise.resolve({ accountId: "42", login: "octo" }),
    persist: (account, alias) => {
      persisted.push({ account, alias })
      return Promise.resolve()
    },
    now: () => now,
    ...overrides,
  })
  return {
    login,
    token,
    persisted,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe("GitHub device sign-in", () => {
  test("shows the code, then saves the confirmed account", async () => {
    const { login, token, persisted } = setup()

    const started = await login.start("Work")

    expect(started).toEqual({
      flowId: expect.any(String) as string,
      status: "pending",
      userCode: "ABCD-1234",
      verificationUrl: "https://github.com/login/device",
      expiresAt: 1_000 + 900_000,
    })
    expect(JSON.stringify(started)).not.toContain("device-secret")
    expect(login.hasPending()).toBe(true)

    token.resolve("gho_token")
    await settle()

    expect(persisted).toEqual([
      {
        account: { accountId: "42", login: "octo", token: "gho_token" },
        alias: "Work",
      },
    ])
    expect(login.status(started.flowId)).toEqual({
      flowId: started.flowId,
      status: "succeeded",
      accountId: "42",
      login: "octo",
      alias: "Work",
    })
    expect(login.hasPending()).toBe(false)
  })

  test("cancelling stops the poll and saves nothing", async () => {
    const { login, persisted } = setup()
    const started = await login.start()

    expect(login.cancel(started.flowId)).toEqual({
      flowId: started.flowId,
      status: "cancelled",
    })
    await settle()

    expect(persisted).toEqual([])
    expect(login.status(started.flowId)?.status).toBe("cancelled")
    expect(login.cancel("unknown")).toBeNull()
    expect(login.status("unknown")).toBeNull()
  })

  test("a cancel during the account check does not save the account", async () => {
    const identity = deferred<{ accountId: string; login: string }>()
    const { login, token, persisted } = setup({
      identify: () => identity.promise,
    })
    const started = await login.start()
    token.resolve("gho_token")
    await settle()

    login.cancel(started.flowId)
    identity.resolve({ accountId: "42", login: "octo" })
    await settle()

    expect(persisted).toEqual([])
    expect(login.status(started.flowId)?.status).toBe("cancelled")
  })

  test("reports sign-in errors without leaking details", async () => {
    const { login, token } = setup({
      identify: () => Promise.reject(new Error("token gho_secret rejected")),
    })
    const started = await login.start()
    token.resolve("gho_token")
    await settle()

    expect(login.status(started.flowId)).toEqual({
      flowId: started.flowId,
      status: "failed",
      error: "Sign-in failed. Try again.",
    })
  })

  test("passes messages written for the dashboard through", async () => {
    const { login, token } = setup()
    const started = await login.start()
    token.reject(new GitHubDeviceLoginError("GitHub refused the sign-in."))
    await settle()

    expect(login.status(started.flowId)).toMatchObject({
      status: "failed",
      error: "GitHub refused the sign-in.",
    })
  })

  test("forgets finished sign-ins after a while", async () => {
    const { login, advance } = setup()
    const started = await login.start()
    login.cancel(started.flowId)

    advance(10 * 60 * 1000 + 1)

    expect(login.status(started.flowId)).toBeNull()
  })

  test("limits parallel sign-ins", async () => {
    const { login } = setup()
    for (let index = 0; index < 5; index += 1) await login.start()

    expect(await rejectionOf(login.start())).toMatchObject({
      message: expect.stringContaining("Too many sign-ins") as string,
    })
  })

  test("explains when GitHub issues no code", async () => {
    expect(
      await rejectionOf(
        setup({
          requestDeviceCode: () => Promise.reject(httpError(503)),
        }).login.start(),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "GitHub did not issue a sign-in code (HTTP 503).",
      ) as string,
    })
    expect(
      await rejectionOf(
        setup({
          requestDeviceCode: () => Promise.reject(new TypeError("fetch")),
        }).login.start(),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "GitHub is not reachable. Try again.",
      ) as string,
    })
    expect(
      await rejectionOf(
        setup({
          requestDeviceCode: () =>
            Promise.reject(new GitHubDeviceLoginError("custom")),
        }).login.start(),
      ),
    ).toMatchObject({
      message: expect.stringContaining("custom") as string,
    })
    expect(
      await rejectionOf(
        setup({
          requestDeviceCode: () =>
            Promise.resolve({ ...device, user_code: "" }),
        }).login.start(),
      ),
    ).toMatchObject({
      message: expect.stringContaining("incomplete answer") as string,
    })
  })

  test("only shows an https verification link and caps the lifetime", async () => {
    const unsafe = await setup({
      requestDeviceCode: () =>
        Promise.resolve({
          ...device,
          verification_uri: "javascript:alert(1)",
          expires_in: 99_999,
        }),
    }).login.start()
    const garbled = await setup({
      requestDeviceCode: () =>
        Promise.resolve({
          ...device,
          verification_uri: "not a url",
          expires_in: Number.NaN,
        }),
    }).login.start()
    const missing = await setup({
      requestDeviceCode: () =>
        Promise.resolve({
          ...device,
          verification_uri: undefined as unknown as string,
        }),
    }).login.start()

    for (const flow of [unsafe, garbled, missing]) {
      expect(flow).toMatchObject({
        verificationUrl: GITHUB_DEVICE_VERIFICATION_URL,
      })
    }
    expect(unsafe).toMatchObject({ expiresAt: 1_000 + 15 * 60 * 1000 })
    expect(garbled).toMatchObject({ expiresAt: 1_000 + 15 * 60 * 1000 })
  })
})

describe("GitHub poll errors", () => {
  test("map to dashboard messages", () => {
    expect(
      toGitHubPollError(
        new Error("GitHub device code expired before authorization completed."),
      ).message,
    ).toBe("The code expired. Start the sign-in again.")
    expect(
      toGitHubPollError(
        new Error("GitHub device authorization failed: access_denied"),
      ),
    ).toBeInstanceOf(GitHubDeviceLoginError)
    const other = new Error("boom")
    expect(toGitHubPollError(other)).toBe(other)
    expect(toGitHubPollError("text").message).toBe("text")
  })
})

describe("GitHub Copilot account check", () => {
  const signal = new AbortController().signal

  test("returns the numeric id as text and the login", async () => {
    expect(
      await identifyGitHubCopilotAccount("gho", signal, {
        getUser: () => Promise.resolve({ id: 583231, login: "octocat" }),
        getCopilotToken: () => Promise.resolve({}),
      }),
    ).toEqual({ accountId: "583231", login: "octocat" })
  })

  test("rejects incomplete user answers", async () => {
    expect(
      await rejectionOf(
        identifyGitHubCopilotAccount("gho", signal, {
          getUser: () => Promise.resolve({ id: 1.5, login: "octocat" }),
          getCopilotToken: () => Promise.resolve({}),
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("incomplete answer") as string,
    })
  })

  test("explains a token GitHub does not accept", async () => {
    expect(
      await rejectionOf(
        identifyGitHubCopilotAccount("gho", signal, {
          getUser: () => Promise.reject(httpError(401)),
          getCopilotToken: () => Promise.resolve({}),
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "GitHub did not accept the new sign-in (HTTP 401).",
      ) as string,
    })
    expect(
      await rejectionOf(
        identifyGitHubCopilotAccount("gho", signal, {
          getUser: () => Promise.reject(new TypeError("fetch failed")),
          getCopilotToken: () => Promise.resolve({}),
        }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("GitHub is not reachable") as string,
    })
  })

  test("explains an account without Copilot", async () => {
    const api = (error: Error) => ({
      getUser: () => Promise.resolve({ id: "9", login: "nocopilot" }),
      getCopilotToken: () => Promise.reject(error),
    })

    expect(
      await rejectionOf(
        identifyGitHubCopilotAccount("gho", signal, api(httpError(404))),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "GitHub account nocopilot cannot use Copilot.",
      ) as string,
    })
    expect(
      await rejectionOf(
        identifyGitHubCopilotAccount("gho", signal, api(httpError(500))),
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "Copilot check failed (HTTP 500).",
      ) as string,
    })
    expect(
      await rejectionOf(
        identifyGitHubCopilotAccount("gho", signal, api(new Error("offline"))),
      ),
    ).toMatchObject({
      message: expect.stringContaining("GitHub is not reachable") as string,
    })
  })

  test("quotes GitHub's reason, for example locked billing", async () => {
    const locked = new HTTPError(
      "Failed to get Copilot token (GitHub responded 403)",
      Response.json(
        {
          error_details: {
            message: "Your account's billing is currently locked.",
            notification_id: "billing_locked",
          },
          message: "Forbidden",
        },
        { status: 403 },
      ),
    )
    const busy = new HTTPError(
      "Failed to get Copilot token (GitHub responded 503)",
      Response.json({ message: "Service unavailable" }, { status: 503 }),
    )
    const api = (error: Error) => ({
      getUser: () => Promise.resolve({ id: 9, login: "octo" }),
      getCopilotToken: () => Promise.reject(error),
    })

    expect(
      await rejectionOf(
        identifyGitHubCopilotAccount("gho", signal, api(locked)),
      ),
    ).toMatchObject({
      message:
        "GitHub account octo cannot use Copilot. GitHub says: Your account's billing is currently locked.",
    })
    expect(
      await rejectionOf(identifyGitHubCopilotAccount("gho", signal, api(busy))),
    ).toMatchObject({
      message:
        "Copilot check failed (HTTP 503). GitHub says: Service unavailable",
    })
  })

  test("passes a cancel through unchanged", async () => {
    const controller = new AbortController()
    controller.abort()
    const reason = new Error("aborted")

    expect(
      await rejectionOf(
        identifyGitHubCopilotAccount("gho", controller.signal, {
          getUser: () => Promise.reject(reason),
          getCopilotToken: () => Promise.resolve({}),
        }),
      ),
    ).toBe(reason)
    expect(
      await rejectionOf(
        identifyGitHubCopilotAccount("gho", controller.signal, {
          getUser: () => Promise.resolve({ id: 1, login: "octo" }),
          getCopilotToken: () => Promise.reject(reason),
        }),
      ),
    ).toBe(reason)
  })
})
