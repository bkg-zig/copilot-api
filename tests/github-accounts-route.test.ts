import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type {
  GitHubAccountList,
  GitHubAccountManager,
  GitHubAccountSummary,
} from "~/lib/github-accounts"
import type { GitHubDeviceFlowStatus } from "~/lib/oauth/github-device-login"

import { HTTPError } from "~/lib/error"
import {
  createGitHubAccountManager,
  GitHubAccountError,
} from "~/lib/github-accounts"
import { GitHubDeviceLoginError } from "~/lib/oauth/github-device-login"
import {
  createGitHubAuthDependencies,
  createGitHubAuthRoutes,
  githubAuthRoutes,
  readCopilotStatus,
  type CopilotStatus,
  type GitHubAuthApi,
} from "~/routes/admin/config/github-accounts-route"

const summary = (
  overrides: Partial<GitHubAccountSummary> = {},
): GitHubAccountSummary => ({
  accountId: "1",
  login: "octo",
  active: true,
  addedAt: 1,
  ...overrides,
})

const pending: GitHubDeviceFlowStatus = {
  flowId: "flow-1",
  status: "pending",
  userCode: "ABCD-1234",
  verificationUrl: "https://github.com/login/device",
  expiresAt: 2,
}

let calls: Array<string>
let accountCount: number
let tokenOverride: boolean
let removeResult: Awaited<ReturnType<GitHubAccountManager["remove"]>>
let startError: Error | undefined
let listError: Error | undefined
let copilotState: CopilotStatus

function createApp() {
  const accounts: GitHubAccountManager = {
    list: () =>
      listError ?
        Promise.reject(listError)
      : Promise.resolve<GitHubAccountList>({
          accounts: [summary()],
          tokenOverride,
          outsideToken: false,
        }),
    count: () => Promise.resolve(accountCount),
    add: () => Promise.resolve(summary()),
    select: (accountId) => {
      calls.push(`select:${accountId}`)
      return accountId === "missing" ?
          Promise.reject(
            new GitHubAccountError("GitHub account not found.", 404),
          )
        : Promise.resolve(summary({ accountId }))
    },
    remove: (accountId) => {
      calls.push(`remove:${accountId}`)
      return Promise.resolve(removeResult)
    },
    rename: (accountId, alias) => {
      calls.push(`rename:${accountId}:${String(alias)}`)
      return typeof alias === "string" && alias.trim() ?
          Promise.resolve(summary({ accountId, alias }))
        : Promise.reject(
            new GitHubAccountError("Account name must be 1-64 characters."),
          )
    },
    hasTokenOverride: () => tokenOverride,
  }
  const routes = createGitHubAuthRoutes({
    accounts,
    deviceLogin: {
      start: (alias) => {
        calls.push(`start:${alias ?? ""}`)
        return startError ?
            Promise.reject(startError)
          : Promise.resolve(pending)
      },
      status: (flowId) => (flowId === "flow-1" ? pending : null),
      cancel: (flowId) =>
        flowId === "flow-1" ? { flowId, status: "cancelled" } : null,
    },
    setCopilotEnabled: (enabled) => {
      calls.push(`copilot:${enabled}`)
    },
    copilotStatus: () => copilotState,
    reload: () => {
      calls.push("reload")
      return Promise.reject(new Error("reload failures are only logged"))
    },
  })
  const app = new Hono()
  app.route("/admin/config", routes)
  return app
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

beforeEach(() => {
  calls = []
  accountCount = 0
  tokenOverride = false
  startError = undefined
  listError = undefined
  copilotState = { enabled: true, running: true }
  removeResult = {
    account: summary({ active: false }),
    wasActive: false,
    remaining: 1,
  }
})

describe("GitHub sign-in routes", () => {
  test("starts a device sign-in with an optional name", async () => {
    const app = createApp()

    const named = await app.request(
      "/admin/config/auth/github/device/start",
      json({ alias: " Work " }),
    )
    const unnamed = await app.request(
      "/admin/config/auth/github/device/start",
      { method: "POST", body: "not json" },
    )

    expect(named.status).toBe(200)
    expect(await named.json()).toEqual(pending)
    expect(unnamed.status).toBe(200)
    expect(calls).toEqual(["start:Work", "start:"])
  })

  test("refuses a bad name and a full account list before contacting GitHub", async () => {
    const app = createApp()

    const badName = await app.request(
      "/admin/config/auth/github/device/start",
      json({ alias: "x".repeat(65) }),
    )
    accountCount = 10
    const full = await app.request(
      "/admin/config/auth/github/device/start",
      json({}),
    )

    expect(badName.status).toBe(400)
    expect(full.status).toBe(409)
    expect(await full.json()).toEqual({
      error: {
        message: "Up to 10 GitHub accounts. Remove one first.",
        type: "invalid_request_error",
      },
    })
    expect(calls).toEqual([])
  })

  test("returns sign-in errors as 400", async () => {
    startError = new GitHubDeviceLoginError("GitHub is not reachable.")
    const response = await createApp().request(
      "/admin/config/auth/github/device/start",
      json({}),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: "GitHub is not reachable.",
        type: "invalid_request_error",
      },
    })
  })

  test("reports and cancels a sign-in", async () => {
    const app = createApp()

    const status = await app.request("/admin/config/auth/github/device/flow-1")
    const cancelled = await app.request(
      "/admin/config/auth/github/device/flow-1",
      { method: "DELETE" },
    )
    const missing = await app.request("/admin/config/auth/github/device/nope")
    const missingCancel = await app.request(
      "/admin/config/auth/github/device/nope",
      { method: "DELETE" },
    )

    expect(await status.json()).toEqual(pending)
    expect(await cancelled.json()).toEqual({
      flowId: "flow-1",
      status: "cancelled",
    })
    expect(missing.status).toBe(404)
    expect(missingCancel.status).toBe(404)
  })
})

describe("GitHub account routes", () => {
  test("lists accounts with the limit", async () => {
    const response = await createApp().request("/admin/config/github/accounts")

    expect(await response.json()).toEqual({
      accounts: [summary()],
      tokenOverride: false,
      outsideToken: false,
      maxAccounts: 10,
      copilot: { enabled: true, running: true },
    })
  })

  test("forwards unexpected list failures", async () => {
    listError = new Error("disk failed")
    const response = await createApp().request("/admin/config/github/accounts")

    expect(response.status).toBe(500)
  })

  test("switching turns Copilot on and reloads", async () => {
    const app = createApp()

    const response = await app.request(
      "/admin/config/github/accounts/select",
      json({ accountId: "2" }),
    )
    const invalid = await app.request(
      "/admin/config/github/accounts/select",
      json({}),
    )
    const missing = await app.request(
      "/admin/config/github/accounts/select",
      json({ accountId: "missing" }),
    )

    expect(await response.json()).toEqual({
      success: true,
      account: summary({ accountId: "2" }),
      copilot: { enabled: true, running: true },
    })
    expect(invalid.status).toBe(400)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      error: { message: "GitHub account not found.", type: "not_found" },
    })
    expect(calls).toEqual([
      "select:2",
      "copilot:true",
      "reload",
      "select:missing",
    ])
  })

  test("switching says when Copilot does not start with the account", async () => {
    copilotState = {
      enabled: true,
      running: false,
      error: "Your account's billing is currently locked.",
    }

    const response = await createApp().request(
      "/admin/config/github/accounts/select",
      json({ accountId: "2" }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      copilot: {
        running: false,
        error: "Your account's billing is currently locked.",
      },
    })
  })

  test("removing an idle account leaves Copilot alone", async () => {
    const response = await createApp().request(
      "/admin/config/github/accounts/remove",
      json({ accountId: "2" }),
    )

    expect(response.status).toBe(200)
    expect(calls).toEqual(["remove:2"])
  })

  test("signing out the last account turns Copilot off", async () => {
    removeResult = { account: summary(), wasActive: true, remaining: 0 }

    await createApp().request(
      "/admin/config/github/accounts/remove",
      json({ accountId: "1" }),
    )

    expect(calls).toEqual(["remove:1", "copilot:false", "reload"])
  })

  test("a token from the server start keeps Copilot on", async () => {
    removeResult = { account: summary(), wasActive: true, remaining: 0 }
    tokenOverride = true
    const app = createApp()

    await app.request(
      "/admin/config/github/accounts/remove",
      json({ accountId: "1" }),
    )
    const invalid = await app.request(
      "/admin/config/github/accounts/remove",
      json({ accountId: " " }),
    )

    expect(calls).toEqual(["remove:1", "reload"])
    expect(invalid.status).toBe(400)
  })

  test("renames an account", async () => {
    const app = createApp()

    const renamed = await app.request("/admin/config/github/accounts/a%2Fb", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias: "Work" }),
    })
    const invalid = await app.request("/admin/config/github/accounts/1", {
      method: "PATCH",
      body: "{}",
    })

    expect(await renamed.json()).toEqual({
      success: true,
      account: summary({ accountId: "a/b", alias: "Work" }),
    })
    expect(invalid.status).toBe(400)
  })

  test("the default routes are wired", () => {
    expect(githubAuthRoutes.routes.map((route) => route.path)).toContain(
      "/github/accounts",
    )
  })
})

describe("Copilot status for the dashboard", () => {
  const reason = "Your account's billing is currently locked."

  test("a running Copilot hides an old failure", () => {
    expect(
      readCopilotStatus(
        {},
        { githubToken: "gho", copilotToken: "cop", copilotSetupError: reason },
      ),
    ).toEqual({ enabled: true, running: true })
  })

  test("a stopped Copilot gives the reason", () => {
    expect(
      readCopilotStatus({}, { githubToken: "gho", copilotSetupError: reason }),
    ).toEqual({ enabled: true, running: false, error: reason })
    expect(readCopilotStatus({}, {})).toEqual({
      enabled: true,
      running: false,
    })
  })

  test("a disabled Copilot is reported as off", () => {
    expect(
      readCopilotStatus(
        { providers: { "github-copilot": { enabled: false } } },
        { githubToken: "gho", copilotToken: "cop" },
      ),
    ).toEqual({ enabled: false, running: false })
  })
})

describe("GitHub sign-in wiring", () => {
  const tempDirs: Array<string> = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Saving takes a file lock, so give the background flow real time.
  async function finished(
    deps: ReturnType<typeof createGitHubAuthDependencies>,
    flowId: string,
  ) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const status = deps.deviceLogin.status(flowId)
      if (status?.status !== "pending") return status
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return deps.deviceLogin.status(flowId)
  }

  function wire(overrides: Partial<GitHubAuthApi> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "github-wiring-"))
    tempDirs.push(dir)
    let activeToken: string | null = null
    const events: Array<string> = []
    const api: GitHubAuthApi = {
      getDeviceCode: () =>
        Promise.resolve({
          device_code: "device",
          user_code: "WXYZ-0000",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        }),
      pollAccessToken: () => Promise.resolve("gho_new"),
      getGitHubUser: () => Promise.resolve({ id: 7, login: "octo" }),
      getCopilotToken: () => Promise.resolve({}),
      setCopilotEnabled: (enabled) => {
        events.push(`copilot:${enabled}`)
      },
      reload: () => {
        events.push("reload")
        return Promise.resolve()
      },
      copilotStatus: () => ({ enabled: true, running: true }),
      hasTokenOverride: () => false,
      now: () => 5,
      ...overrides,
    }
    const deps = createGitHubAuthDependencies(api, (options) =>
      createGitHubAccountManager({
        ...options,
        storePath: () => path.join(dir, "github_accounts.json"),
        readActiveToken: () => Promise.resolve(activeToken),
        writeActiveToken: (token) => {
          activeToken = token || null
          events.push("token")
          return Promise.resolve()
        },
        now: api.now,
      }),
    )
    return {
      deps,
      events,
      setActiveToken: (token: string) => (activeToken = token),
    }
  }

  test("a confirmed sign-in saves the account, turns Copilot on and reloads", async () => {
    const { deps, events } = wire()

    const started = await deps.deviceLogin.start("Work")
    expect(await finished(deps, started.flowId)).toEqual({
      flowId: started.flowId,
      status: "succeeded",
      accountId: "7",
      login: "octo",
      alias: "Work",
    })
    expect(events).toEqual(["token", "copilot:true", "reload"])
    expect((await deps.accounts.list()).accounts).toEqual([
      {
        accountId: "7",
        login: "octo",
        alias: "Work",
        active: true,
        addedAt: 5,
      },
    ])
  })

  test("a Copilot start failure keeps the saved account and says so", async () => {
    const { deps } = wire({
      reload: () => Promise.reject(new Error("copilot token 500")),
    })

    const started = await deps.deviceLogin.start()
    expect(await finished(deps, started.flowId)).toMatchObject({
      status: "failed",
      error: "Account saved, but Copilot did not start. Check the server log.",
    })
    expect(await deps.accounts.count()).toBe(1)
  })

  test("a Copilot that does not start after sign-in gives GitHub's reason", async () => {
    const { deps, events } = wire({
      copilotStatus: () => ({
        enabled: true,
        running: false,
        error: "Your account's billing is currently locked.",
      }),
    })

    const started = await deps.deviceLogin.start()
    expect(await finished(deps, started.flowId)).toMatchObject({
      status: "failed",
      error:
        "Account saved, but Copilot did not start: Your account's billing is currently locked.",
    })
    expect(events).toEqual(["token", "copilot:true", "reload"])
    expect(await deps.accounts.count()).toBe(1)
  })

  test("poll errors become dashboard messages", async () => {
    const { deps } = wire({
      pollAccessToken: () =>
        Promise.reject(
          new Error(
            "GitHub device code expired before authorization completed.",
          ),
        ),
    })

    const started = await deps.deviceLogin.start()
    expect(await finished(deps, started.flowId)).toMatchObject({
      status: "failed",
      error: "The code expired. Start the sign-in again.",
    })
  })

  test("a cancelled poll is reported as cancelled", async () => {
    const { deps } = wire({
      pollAccessToken: (_device, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason as Error),
            {
              once: true,
            },
          )
        }),
    })

    const started = await deps.deviceLogin.start()
    deps.deviceLogin.cancel(started.flowId)

    expect((await finished(deps, started.flowId))?.status).toBe("cancelled")
  })

  test("an account without Copilot is not saved", async () => {
    const { deps, events } = wire({
      getCopilotToken: () =>
        Promise.reject(
          new HTTPError("no", new Response("{}", { status: 404 })),
        ),
    })

    const started = await deps.deviceLogin.start()
    expect(await finished(deps, started.flowId)).toMatchObject({
      status: "failed",
      error: "GitHub account octo cannot use Copilot. Check its Copilot plan.",
    })
    expect(events).toEqual([])
  })

  test("a token from outside the dashboard is looked up by its owner", async () => {
    const { deps, setActiveToken } = wire({
      getGitHubUser: () => Promise.resolve({ id: 99, login: "cli-user" }),
    })
    setActiveToken("gho_cli")

    expect((await deps.accounts.list()).accounts).toEqual([
      { accountId: "99", login: "cli-user", active: true, addedAt: 5 },
    ])
  })
})
