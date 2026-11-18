import {
  CODEX_REDIRECT_URI,
  completeCodexAuth,
  createCodexAuthUrl,
  parseAuthorizationInput,
  type CodexCredentials,
} from "./codex"

/**
 * Codex sign-in for headless servers, driven from the web dashboard.
 *
 * OpenAI only accepts the registered `http://localhost:1455/auth/callback`
 * redirect for the Codex client. On a server that redirect cannot be served,
 * so the user signs in in their own browser, lands on the (unreachable)
 * localhost page and pastes that URL back. The PKCE verifier never leaves the
 * server: it is kept here, keyed by the OAuth `state`, until the paste arrives.
 */

const LOGIN_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_LOGINS = 20

interface PendingLogin {
  verifier: string
  alias?: string
  expiresAt: number
}

export class CodexWebLoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodexWebLoginError"
  }
}

export interface CodexWebLoginStart {
  authUrl: string
  state: string
  redirectUri: string
  expiresAt: number
}

export interface CodexWebLoginDependencies {
  createAuthUrl: typeof createCodexAuthUrl
  completeAuth: typeof completeCodexAuth
  persist: (
    credentials: CodexCredentials,
    alias: string | undefined,
  ) => Promise<void>
  now: () => number
}

export function normalizeCodexAlias(alias: unknown): string | undefined {
  if (alias === undefined || alias === null) return undefined
  if (typeof alias !== "string") {
    throw new CodexWebLoginError("Alias must be a string.")
  }
  const trimmed = alias.trim()
  if (!trimmed) return undefined
  if (!/^[\w.-]{1,32}$/.test(trimmed)) {
    throw new CodexWebLoginError(
      "Alias may only use letters, digits, '.', '_' or '-' (max 32).",
    )
  }
  return trimmed
}

export function createCodexWebLogin(deps: CodexWebLoginDependencies) {
  const pending = new Map<string, PendingLogin>()

  const prune = (): void => {
    const now = deps.now()
    for (const [state, login] of pending) {
      if (login.expiresAt <= now) pending.delete(state)
    }
  }

  async function start(alias?: unknown): Promise<CodexWebLoginStart> {
    const normalizedAlias = normalizeCodexAlias(alias)
    prune()
    if (pending.size >= MAX_PENDING_LOGINS) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
    const { url, state, verifier } =
      await deps.createAuthUrl(CODEX_REDIRECT_URI)
    const expiresAt = deps.now() + LOGIN_TTL_MS
    pending.set(state, { verifier, alias: normalizedAlias, expiresAt })
    return { authUrl: url, state, redirectUri: CODEX_REDIRECT_URI, expiresAt }
  }

  async function finish(
    state: unknown,
    input: unknown,
  ): Promise<{ accountId: string; alias?: string }> {
    if (typeof state !== "string" || !state) {
      throw new CodexWebLoginError(
        "Missing login state. Start the sign-in again.",
      )
    }
    if (typeof input !== "string" || !input.trim()) {
      throw new CodexWebLoginError(
        "Paste the full address from the browser (http://localhost:1455/auth/callback?code=…).",
      )
    }
    prune()
    const login = pending.get(state)
    if (!login) {
      throw new CodexWebLoginError(
        "This sign-in has expired or was already used. Start it again.",
      )
    }
    const parsed = parseAuthorizationInput(input)
    if (parsed.state && parsed.state !== state) {
      throw new CodexWebLoginError(
        "The pasted address belongs to a different sign-in. Use the link from this page.",
      )
    }
    if (!parsed.code) {
      throw new CodexWebLoginError(
        "No authorization code found in the pasted text.",
      )
    }
    // One attempt per state: a code can only be exchanged once anyway.
    pending.delete(state)
    const credentials = await deps.completeAuth({
      code: parsed.code,
      state,
      verifier: login.verifier,
      redirectUri: CODEX_REDIRECT_URI,
    })
    await deps.persist(credentials, login.alias)
    return { accountId: credentials.accountId, alias: login.alias }
  }

  return { start, finish, pendingCount: () => pending.size }
}
