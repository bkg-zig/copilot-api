import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createDefaultGitHubAccountManager,
  createGitHubAccountManager,
  GitHubAccountError,
  MAX_GITHUB_ACCOUNTS,
  normalizeGitHubAccountAlias,
  type GitHubIdentity,
} from "~/lib/github-accounts"
import { PATHS } from "~/lib/paths"

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject")
}

const originalAccountsPath = PATHS.GITHUB_ACCOUNTS_PATH
const originalTokenPath = PATHS.GITHUB_TOKEN_PATH
const tempDirs: Array<string> = []

afterEach(() => {
  PATHS.GITHUB_ACCOUNTS_PATH = originalAccountsPath
  PATHS.GITHUB_TOKEN_PATH = originalTokenPath
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "github-accounts-"))
  tempDirs.push(dir)
  return dir
}

function setup(
  options: {
    activeToken?: string | null
    tokenOverride?: boolean
    lookupIdentity?: (token: string) => Promise<GitHubIdentity>
  } = {},
) {
  const storePath = path.join(tempDir(), "github_accounts.json")
  let activeToken = options.activeToken ?? null
  let now = 0
  const lookups: Array<string> = []
  const manager = createGitHubAccountManager({
    storePath: () => storePath,
    readActiveToken: () => Promise.resolve(activeToken),
    writeActiveToken: (token) => {
      activeToken = token || null
      return Promise.resolve()
    },
    hasTokenOverride: () => options.tokenOverride ?? false,
    lookupIdentity: (token) => {
      lookups.push(token)
      return (
        options.lookupIdentity?.(token) ?? Promise.reject(new Error("offline"))
      )
    },
    now: () => (now += 1),
  })
  const readFile = () =>
    JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      accounts: Array<Record<string, unknown>>
    }
  return {
    manager,
    storePath,
    lookups,
    readFile,
    activeToken: () => activeToken,
    setActiveToken: (token: string) => {
      activeToken = token
    },
  }
}

const octo = { accountId: "1", login: "octo", token: "gho_one" }
const hubot = { accountId: "2", login: "hubot", token: "gho_two" }

describe("GitHub account store", () => {
  test("starts empty when no account file exists", async () => {
    const { manager } = setup()

    expect(await manager.list()).toEqual({
      accounts: [],
      tokenOverride: false,
      outsideToken: false,
    })
    expect(await manager.count()).toBe(0)
  })

  test("adds accounts, puts the newest in use and never lists tokens", async () => {
    const { manager, activeToken, readFile, storePath } = setup()

    await manager.add(octo)
    const added = await manager.add(hubot, "Work")

    expect(added).toEqual({
      accountId: "2",
      login: "hubot",
      alias: "Work",
      active: true,
      addedAt: 2,
    })
    expect(activeToken()).toBe("gho_two")
    const listed = await manager.list()
    expect(
      listed.accounts.map((account) => [account.login, account.active]),
    ).toEqual([
      ["octo", false],
      ["hubot", true],
    ])
    expect(JSON.stringify(listed)).not.toContain("gho_")
    expect(readFile().accounts).toHaveLength(2)
    if (process.platform !== "win32") {
      expect(fs.statSync(storePath).mode & 0o777).toBe(0o600)
    }
  })

  test("signing in again renews the token and keeps name and date", async () => {
    const { manager, activeToken, readFile } = setup()
    await manager.add(octo, "Private")
    await manager.add(hubot)

    const renewed = await manager.add({ ...octo, token: "gho_new" })

    expect(renewed).toMatchObject({ alias: "Private", addedAt: 1 })
    expect(activeToken()).toBe("gho_new")
    expect(readFile().accounts).toHaveLength(2)
    expect(readFile().accounts[0]).toMatchObject({ token: "gho_new" })
  })

  test(`stores at most ${MAX_GITHUB_ACCOUNTS} accounts`, async () => {
    const { manager } = setup()
    for (let index = 0; index < MAX_GITHUB_ACCOUNTS; index += 1) {
      await manager.add({
        accountId: String(index),
        login: `user${index}`,
        token: `gho_${index}`,
      })
    }

    const error = await manager
      .add({ accountId: "new", login: "new", token: "gho_new" })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(GitHubAccountError)
    expect(error).toMatchObject({ status: 409 })
    expect(
      await manager.add({ accountId: "3", login: "user3", token: "gho_again" }),
    ).toMatchObject({ accountId: "3" })
  })

  test("switches the account in use", async () => {
    const { manager, activeToken } = setup()
    await manager.add(octo)
    await manager.add(hubot)

    expect(await manager.select(" 1 ")).toMatchObject({
      login: "octo",
      active: true,
    })
    expect(activeToken()).toBe("gho_one")
    expect(await rejectionOf(manager.select("missing"))).toMatchObject({
      status: 404,
    })
  })

  test("removes idle accounts but not the one in use while others exist", async () => {
    const { manager, activeToken } = setup()
    await manager.add(octo)
    await manager.add(hubot)

    expect(await rejectionOf(manager.remove("2"))).toMatchObject({
      status: 409,
    })
    expect(await manager.remove("1")).toEqual({
      account: {
        accountId: "1",
        login: "octo",
        active: false,
        addedAt: 1,
      },
      wasActive: false,
      remaining: 1,
    })
    expect(activeToken()).toBe("gho_two")
  })

  test("removing the last account signs Copilot out", async () => {
    const { manager, activeToken } = setup()
    await manager.add(octo)

    expect(await manager.remove("1")).toMatchObject({
      wasActive: true,
      remaining: 0,
    })
    expect(activeToken()).toBeNull()
    expect((await manager.list()).accounts).toEqual([])
  })

  test("renames accounts and validates the name", async () => {
    const { manager } = setup()
    await manager.add(octo)
    await manager.add(hubot)

    expect(await manager.rename("1", "  Work  ")).toEqual({
      accountId: "1",
      login: "octo",
      alias: "Work",
      active: false,
      addedAt: 1,
    })
    expect(await manager.rename("2", "Team")).toMatchObject({
      active: true,
    })
    expect(
      await rejectionOf(manager.rename("1", "bad\u0007name")),
    ).toBeInstanceOf(GitHubAccountError)
    expect(
      await rejectionOf(manager.rename("1", "x".repeat(65))),
    ).toMatchObject({
      message: expect.stringContaining(
        "Account name must be 1-64 characters",
      ) as string,
    })
    expect(await rejectionOf(manager.rename("1", 42))).toMatchObject({
      message: expect.stringContaining("Account name") as string,
    })
    expect(await rejectionOf(manager.rename("nobody", "Name"))).toMatchObject({
      status: 404,
    })
    expect(normalizeGitHubAccountAlias(" Ok ")).toBe("Ok")
  })

  test("adopts a token saved outside the dashboard once its owner is known", async () => {
    const { manager, lookups } = setup({
      activeToken: "gho_cli",
      lookupIdentity: () => Promise.resolve({ accountId: "7", login: "cli" }),
    })

    const listed = await manager.list()

    expect(lookups).toEqual(["gho_cli"])
    expect(listed.outsideToken).toBe(false)
    expect(listed.accounts).toEqual([
      { accountId: "7", login: "cli", active: true, addedAt: 1 },
    ])
    await manager.list()
    expect(lookups).toHaveLength(1)
  })

  test("a newer token for a saved account replaces the old one", async () => {
    const { manager, readFile, setActiveToken, lookups } = setup({
      lookupIdentity: () => Promise.resolve({ accountId: "1", login: "octo" }),
    })
    await manager.add(octo, "Private")
    await manager.add(hubot)
    // `copilot-api auth` wrote a fresh token for octo.
    setActiveToken("gho_fresh")

    const listed = await manager.list()

    expect(lookups).toEqual(["gho_fresh"])
    expect(listed.accounts).toEqual([
      {
        accountId: "1",
        login: "octo",
        alias: "Private",
        active: true,
        addedAt: 1,
      },
      { accountId: "2", login: "hubot", active: false, addedAt: 2 },
    ])
    expect(readFile().accounts[0]).toMatchObject({ token: "gho_fresh" })
  })

  test("leaves a full list alone when an unknown account's token is in use", async () => {
    const { manager, setActiveToken } = setup({
      lookupIdentity: () => Promise.resolve({ accountId: "99", login: "late" }),
    })
    for (let index = 0; index < MAX_GITHUB_ACCOUNTS; index += 1) {
      await manager.add({
        accountId: String(index),
        login: `user${index}`,
        token: `gho_${index}`,
      })
    }
    setActiveToken("gho_late")

    const listed = await manager.list()

    expect(listed.accounts).toHaveLength(MAX_GITHUB_ACCOUNTS)
    expect(listed.outsideToken).toBe(true)
  })

  test("reports a token it cannot attribute", async () => {
    const { manager } = setup({ activeToken: "gho_unknown" })

    expect(await manager.list()).toEqual({
      accounts: [],
      tokenOverride: false,
      outsideToken: true,
    })
  })

  test("reports a token passed at server start", async () => {
    const { manager } = setup({ tokenOverride: true })

    expect((await manager.list()).tokenOverride).toBe(true)
    expect(manager.hasTokenOverride()).toBe(true)
  })

  test("refuses to overwrite a damaged account file", async () => {
    const { manager, storePath } = setup()
    fs.writeFileSync(storePath, "{not json")

    expect(await rejectionOf(manager.list())).toMatchObject({
      message: expect.stringContaining("not valid JSON") as string,
    })
    expect(await rejectionOf(manager.add(octo))).toMatchObject({
      message: expect.stringContaining("not valid JSON") as string,
    })
    expect(fs.readFileSync(storePath, "utf8")).toBe("{not json")
  })

  test("drops invalid and duplicate entries when reading", async () => {
    const { manager, storePath } = setup({ activeToken: "gho_one" })
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        accounts: [
          { ...octo, alias: " Main ", addedAt: 5 },
          { ...octo, token: "gho_dup" },
          { accountId: "3", login: "", token: "gho_x" },
          "nonsense",
          { ...hubot, addedAt: "yesterday" },
        ],
      }),
    )

    expect((await manager.list()).accounts).toEqual([
      {
        accountId: "1",
        login: "octo",
        alias: "Main",
        active: true,
        addedAt: 5,
      },
      { accountId: "2", login: "hubot", active: false, addedAt: 0 },
    ])
  })
})

describe("default GitHub account manager", () => {
  test("mirrors the account in use into the github_token file", async () => {
    const dir = tempDir()
    PATHS.GITHUB_ACCOUNTS_PATH = path.join(dir, "github_accounts.json")
    PATHS.GITHUB_TOKEN_PATH = path.join(dir, "github_token")
    const manager = createDefaultGitHubAccountManager({
      hasTokenOverride: () => false,
      lookupIdentity: () => Promise.reject(new Error("offline")),
    })

    await manager.add(octo)
    expect(fs.readFileSync(PATHS.GITHUB_TOKEN_PATH, "utf8")).toBe("gho_one")
    await manager.add(hubot)
    await manager.select("1")
    expect(fs.readFileSync(PATHS.GITHUB_TOKEN_PATH, "utf8")).toBe("gho_one")
    await manager.remove("2")
    await manager.remove("1")
    expect(fs.readFileSync(PATHS.GITHUB_TOKEN_PATH, "utf8")).toBe("")
    expect((await manager.list()).accounts).toEqual([])
  })
})
