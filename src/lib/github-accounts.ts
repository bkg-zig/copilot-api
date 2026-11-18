import fs from "node:fs/promises"

import { writeFileAtomically } from "./atomic-file"
import {
  MAX_OAUTH_ACCOUNTS,
  readGitHubToken,
  withCredentialFileLock,
  writeGitHubToken,
} from "./credential-store"
import { PATHS } from "./paths"

/**
 * Several GitHub accounts for Copilot. Every account keeps its own OAuth token
 * in `github_accounts.json`; the account in use is the one whose token sits in
 * the `github_token` file, which the Copilot runtime already reads. Switching
 * accounts therefore only rewrites that file and reloads the runtime.
 */

export const MAX_GITHUB_ACCOUNTS = MAX_OAUTH_ACCOUNTS
const MAX_ALIAS_LENGTH = 64

export interface GitHubIdentity {
  /** GitHub's numeric user id as a string; stable across renames. */
  accountId: string
  login: string
}

export interface GitHubStoredAccount extends GitHubIdentity {
  alias?: string
  token: string
  addedAt: number
}

interface GitHubAccountStore {
  version: 1
  accounts: Array<GitHubStoredAccount>
}

export interface GitHubAccountSummary extends GitHubIdentity {
  alias?: string
  active: boolean
  addedAt: number
}

export interface GitHubAccountList {
  accounts: Array<GitHubAccountSummary>
  /** A token passed at server start wins over the account picked here. */
  tokenOverride: boolean
  /** The token in use belongs to none of the saved accounts. */
  outsideToken: boolean
}

export class GitHubAccountError extends Error {
  readonly status: 400 | 404 | 409

  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.name = "GitHubAccountError"
    this.status = status
  }
}

export interface GitHubAccountManagerDependencies {
  storePath: () => string
  readActiveToken: () => Promise<string | null>
  writeActiveToken: (token: string) => Promise<void>
  /** True when an environment variable or CLI flag supplies the token. */
  hasTokenOverride: () => boolean
  /** Finds the owner of a token that was saved outside the dashboard. */
  lookupIdentity: (token: string) => Promise<GitHubIdentity>
  now: () => number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined

function normalizeAccount(raw: unknown): GitHubStoredAccount | null {
  if (!isRecord(raw)) return null
  const accountId = text(raw.accountId)
  const login = text(raw.login)
  const token = text(raw.token)
  if (!accountId || !login || !token) return null
  const alias = text(raw.alias)
  return {
    accountId,
    login,
    ...(alias ? { alias } : {}),
    token,
    addedAt:
      typeof raw.addedAt === "number" && Number.isFinite(raw.addedAt) ?
        raw.addedAt
      : 0,
  }
}

function parseStore(raw: string | null, filePath: string): GitHubAccountStore {
  if (!raw?.trim()) return { version: 1, accounts: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Never overwrite a damaged file: the tokens in it may still be needed.
    throw new Error(`GitHub account file is not valid JSON: ${filePath}`)
  }
  const entries =
    isRecord(parsed) && Array.isArray(parsed.accounts) ? parsed.accounts : []
  const accounts: Array<GitHubStoredAccount> = []
  for (const entry of entries) {
    const account = normalizeAccount(entry)
    if (
      account
      && accounts.length < MAX_GITHUB_ACCOUNTS
      && !accounts.some((known) => known.accountId === account.accountId)
    ) {
      accounts.push(account)
    }
  }
  return { version: 1, accounts }
}

export function normalizeGitHubAccountAlias(alias: unknown): string {
  const normalized = typeof alias === "string" ? alias.trim() : ""
  const hasControlChars = [...normalized].some((ch) => {
    const code = ch.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
  if (!normalized || normalized.length > MAX_ALIAS_LENGTH || hasControlChars) {
    throw new GitHubAccountError(
      `Account name must be 1-${MAX_ALIAS_LENGTH} characters without control characters.`,
    )
  }
  return normalized
}

const summarize = (
  account: GitHubStoredAccount,
  active: boolean,
): GitHubAccountSummary => ({
  accountId: account.accountId,
  login: account.login,
  ...(account.alias ? { alias: account.alias } : {}),
  active,
  addedAt: account.addedAt,
})

export function createGitHubAccountManager(
  deps: GitHubAccountManagerDependencies,
) {
  async function readStore(): Promise<GitHubAccountStore> {
    const filePath = deps.storePath()
    let raw: string | null
    try {
      raw = await fs.readFile(filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      raw = null
    }
    return parseStore(raw, filePath)
  }

  function writeStore(store: GitHubAccountStore): void {
    writeFileAtomically(deps.storePath(), `${JSON.stringify(store, null, 2)}\n`)
  }

  const withLock = <T>(operation: () => Promise<T>): Promise<T> =>
    withCredentialFileLock(deps.storePath(), operation)

  function upsert(
    store: GitHubAccountStore,
    account: GitHubIdentity & { token: string },
    alias: string | undefined,
  ): { store: GitHubAccountStore; saved: GitHubStoredAccount } {
    const existing = store.accounts.find(
      (candidate) => candidate.accountId === account.accountId,
    )
    if (!existing && store.accounts.length >= MAX_GITHUB_ACCOUNTS) {
      throw new GitHubAccountError(
        `Up to ${MAX_GITHUB_ACCOUNTS} GitHub accounts. Remove one first.`,
        409,
      )
    }
    const keptAlias = alias ?? existing?.alias
    const saved: GitHubStoredAccount = {
      accountId: account.accountId,
      login: account.login,
      ...(keptAlias ? { alias: keptAlias } : {}),
      token: account.token,
      addedAt: existing?.addedAt ?? deps.now(),
    }
    return {
      saved,
      store: {
        version: 1,
        accounts:
          existing ?
            store.accounts.map((candidate) =>
              candidate === existing ? saved : candidate,
            )
          : [...store.accounts, saved],
      },
    }
  }

  async function findAccount(accountId: string) {
    const store = await readStore()
    const account = store.accounts.find(
      (candidate) => candidate.accountId === accountId.trim(),
    )
    if (!account) {
      throw new GitHubAccountError("GitHub account not found.", 404)
    }
    return { store, account }
  }

  // A token written by `copilot-api auth` or by hand joins the list once its
  // owner is known, so the dashboard shows every account that can be in use.
  async function adoptOutsideToken(
    store: GitHubAccountStore,
    activeToken: string,
  ): Promise<void> {
    if (store.accounts.some((account) => account.token === activeToken)) return
    let identity: GitHubIdentity
    try {
      identity = await deps.lookupIdentity(activeToken)
    } catch {
      return
    }
    await withLock(async () => {
      const current = await readStore()
      if ((await deps.readActiveToken()) !== activeToken) return
      if (current.accounts.some((account) => account.token === activeToken)) {
        return
      }
      const known = current.accounts.some(
        (account) => account.accountId === identity.accountId,
      )
      if (!known && current.accounts.length >= MAX_GITHUB_ACCOUNTS) return
      writeStore(
        upsert(current, { ...identity, token: activeToken }, undefined).store,
      )
    })
  }

  async function list(): Promise<GitHubAccountList> {
    const activeToken = await deps.readActiveToken()
    if (activeToken) await adoptOutsideToken(await readStore(), activeToken)
    const store = await readStore()
    const accounts = store.accounts.map((account) =>
      summarize(account, Boolean(activeToken) && account.token === activeToken),
    )
    return {
      accounts,
      tokenOverride: deps.hasTokenOverride(),
      outsideToken:
        Boolean(activeToken) && !accounts.some((account) => account.active),
    }
  }

  async function count(): Promise<number> {
    return (await readStore()).accounts.length
  }

  /** Saves a signed-in account (or its new token) and puts it in use. */
  function add(
    account: GitHubIdentity & { token: string },
    alias?: string,
  ): Promise<GitHubAccountSummary> {
    return withLock(async () => {
      const { store, saved } = upsert(await readStore(), account, alias)
      writeStore(store)
      await deps.writeActiveToken(saved.token)
      return summarize(saved, true)
    })
  }

  function select(accountId: string): Promise<GitHubAccountSummary> {
    return withLock(async () => {
      const { account } = await findAccount(accountId)
      await deps.writeActiveToken(account.token)
      return summarize(account, true)
    })
  }

  /**
   * Removing the account in use is only allowed when it is the last one; it
   * signs Copilot out. With other accounts saved, the user switches first, so
   * Copilot never silently changes to a different GitHub account.
   */
  function remove(accountId: string): Promise<{
    account: GitHubAccountSummary
    wasActive: boolean
    remaining: number
  }> {
    return withLock(async () => {
      const { store, account } = await findAccount(accountId)
      const active = account.token === (await deps.readActiveToken())
      if (active && store.accounts.length > 1) {
        throw new GitHubAccountError(
          "This account is in use. Switch to another account first.",
          409,
        )
      }
      const accounts = store.accounts.filter(
        (candidate) => candidate !== account,
      )
      writeStore({ version: 1, accounts })
      if (active) await deps.writeActiveToken("")
      return {
        account: summarize(account, false),
        wasActive: active,
        remaining: accounts.length,
      }
    })
  }

  async function rename(
    accountId: string,
    alias: unknown,
  ): Promise<GitHubAccountSummary> {
    const normalized = normalizeGitHubAccountAlias(alias)
    return await withLock(async () => {
      const { store, account } = await findAccount(accountId)
      const renamed = { ...account, alias: normalized }
      writeStore({
        version: 1,
        accounts: store.accounts.map((candidate) =>
          candidate === account ? renamed : candidate,
        ),
      })
      return summarize(
        renamed,
        renamed.token === (await deps.readActiveToken()),
      )
    })
  }

  return {
    list,
    count,
    add,
    select,
    remove,
    rename,
    hasTokenOverride: deps.hasTokenOverride,
  }
}

export type GitHubAccountManager = ReturnType<typeof createGitHubAccountManager>

export function createDefaultGitHubAccountManager(options: {
  hasTokenOverride: () => boolean
  lookupIdentity: (token: string) => Promise<GitHubIdentity>
}): GitHubAccountManager {
  return createGitHubAccountManager({
    storePath: () => PATHS.GITHUB_ACCOUNTS_PATH,
    readActiveToken: readGitHubToken,
    writeActiveToken: writeGitHubToken,
    hasTokenOverride: options.hasTokenOverride,
    lookupIdentity: options.lookupIdentity,
    now: Date.now,
  })
}
