import { createHash, randomBytes, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { z } from "zod"

import { writeFileAtomically } from "~/lib/atomic-file"
import { withCredentialFileLock } from "~/lib/credential-store"
import { PATHS } from "~/lib/paths"

/**
 * Claude subscription sign-in implemented inside the gateway.
 *
 * This follows the flow used by Claude Code itself: PKCE, an authorize URL on
 * claude.ai, and a token exchange against Anthropic's OAuth token endpoint.
 * The redirect target is a localhost URL, so on a headless server the browser
 * cannot reach the gateway. The dashboard therefore collects either the bare
 * code or the full callback URL and submits it back here.
 *
 * The gateway stores the access and refresh token itself, refreshes them
 * before they expire, and never shells out to the Claude Code CLI.
 */

export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
export const CLAUDE_OAUTH_TOKEN_URL =
  "https://platform.claude.com/v1/oauth/token"
export const CLAUDE_OAUTH_USAGE_URL =
  "https://api.anthropic.com/api/oauth/usage"
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const CLAUDE_OAUTH_REDIRECT_URI =
  "https://platform.claude.com/oauth/code/callback"
export const CLAUDE_OAUTH_SCOPE = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
]
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20"
export const CLAUDE_OAUTH_VERSION = "2023-06-01"
// The usage endpoint is undocumented and rate-limits generic clients harder
// than the CLI. Presenting a CLI-like user agent keeps it usable.
export const CLAUDE_OAUTH_USER_AGENT = "claude-cli/2.1.325 (external, cli)"

const LOGIN_TTL_MS = 10 * 60 * 1000
const REFRESH_BUFFER_MS = 60_000
const MAX_PENDING_LOGINS = 5
const TOKEN_TIMEOUT_MS = 30_000
const USAGE_TIMEOUT_MS = 15_000

const tokenResponseSchema = z.object({
  access_token: z.string().trim().min(1),
  refresh_token: z.string().trim().min(1).optional(),
  expires_in: z.number().finite().positive().optional(),
  account: z
    .object({
      uuid: z.string().optional(),
      email_address: z.string().optional(),
    })
    .optional(),
  organization: z
    .object({
      uuid: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
})

const storedCredentialsSchema = z.object({
  version: z.literal(1),
  accessToken: z.string().trim().min(1),
  refreshToken: z.string().trim().min(1),
  expiresAt: z.number().finite().positive(),
  email: z.string().optional(),
  accountId: z.string().optional(),
  subscriptionType: z.string().optional(),
  updatedAt: z.string().optional(),
})

export type ClaudeOAuthTokenResponse = z.infer<typeof tokenResponseSchema>

export interface ClaudeOAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  email?: string
  accountId?: string
  subscriptionType?: string
}

export interface ClaudeOAuthStatus {
  available: boolean
  loggedIn: boolean
  authMethod?: string
  email?: string
  subscriptionType?: string
  expiresAt?: number
  error?: string
}

export interface ClaudeOAuthLoginStart {
  flowId: string
  authUrl: string
  expiresAt: number
}

export interface ClaudeOAuthDependencies {
  fetch?: typeof globalThis.fetch
  now?: () => number
  credentialPath?: string
}

export class ClaudeOAuthError extends Error {
  readonly cause?: unknown

  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = "ClaudeOAuthError"
    this.cause = options?.cause
  }
}

interface PendingLogin {
  state: string
  codeVerifier: string
  expiresAt: number
}

function base64Url(value: Buffer): string {
  return value.toString("base64url")
}

export function createPkcePair(): {
  codeVerifier: string
  codeChallenge: string
} {
  const codeVerifier = base64Url(randomBytes(32))
  const codeChallenge = base64Url(
    createHash("sha256").update(codeVerifier).digest(),
  )
  return { codeVerifier, codeChallenge }
}

/**
 * Anthropic's authorize endpoint expects the colons in scope values to stay
 * readable. The rest of the query is standard URL encoding.
 */
export function buildClaudeAuthorizeUrl(input: {
  state: string
  codeChallenge: string
}): string {
  const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", CLAUDE_OAUTH_REDIRECT_URI)
  url.searchParams.set("scope", CLAUDE_OAUTH_SCOPE.join(" "))
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", input.state)
  return url.toString()
}

/**
 * Accepts the bare code shown after signing in, the `code#state` form some
 * Claude pages show, or the full callback URL. The `code=true` marker inside
 * the generated authorize URL is never a valid login code.
 */
export function parseClaudeSubmittedCode(
  input: string,
): { code: string; state?: string } | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  if (/^https?:\/\//iu.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const code = url.searchParams.get("code")?.trim() ?? ""
      const state = url.searchParams.get("state")?.trim() || undefined
      if (!code || code === "true") return null
      return { code, state }
    } catch {
      return null
    }
  }

  const separator = trimmed.indexOf("#")
  if (separator > 0) {
    const code = trimmed.slice(0, separator).trim()
    const state = trimmed.slice(separator + 1).trim() || undefined
    return code ? { code, state } : null
  }

  return trimmed === "true" ? null : { code: trimmed }
}

export function isClaudeCredentialsExpired(
  credentials: Pick<ClaudeOAuthCredentials, "expiresAt">,
  now = Date.now(),
  bufferMs = REFRESH_BUFFER_MS,
): boolean {
  return credentials.expiresAt - bufferMs <= now
}

function credentialPath(options: ClaudeOAuthDependencies): string {
  return options.credentialPath ?? PATHS.CLAUDE_CREDENTIAL_PATH
}

export async function readClaudeCredentialsAt(
  path: string,
): Promise<ClaudeOAuthCredentials | null> {
  let raw: string
  try {
    raw = await fs.readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (!raw.trim()) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new ClaudeOAuthError(
      "The stored Claude sign-in is not valid JSON. Sign in again.",
      { cause: error },
    )
  }

  const result = storedCredentialsSchema.safeParse(parsed)
  if (!result.success) {
    throw new ClaudeOAuthError(
      "The stored Claude sign-in is incomplete. Sign in again.",
    )
  }
  const { version: _version, ...credentials } = result.data
  return credentials
}

export function readStoredClaudeCredentials(
  options: ClaudeOAuthDependencies = {},
): Promise<ClaudeOAuthCredentials | null> {
  return readClaudeCredentialsAt(credentialPath(options))
}

export async function writeClaudeCredentialsAt(
  path: string,
  credentials: ClaudeOAuthCredentials,
): Promise<void> {
  writeFileAtomically(
    path,
    `${JSON.stringify(
      {
        version: 1,
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
        ...(credentials.email ? { email: credentials.email } : {}),
        ...(credentials.accountId ? { accountId: credentials.accountId } : {}),
        ...(credentials.subscriptionType ?
          { subscriptionType: credentials.subscriptionType }
        : {}),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )
  await fs.chmod(path, 0o600).catch(() => undefined)
}

export async function clearClaudeCredentialsAt(path: string): Promise<void> {
  await fs.rm(path, { force: true })
}

function credentialsFromTokenResponse(
  tokens: ClaudeOAuthTokenResponse,
  current?: ClaudeOAuthCredentials,
  now = Date.now(),
): ClaudeOAuthCredentials {
  const refreshToken = tokens.refresh_token ?? current?.refreshToken
  if (!refreshToken) {
    throw new ClaudeOAuthError(
      "Claude did not return a refresh token. Sign in again.",
    )
  }
  const expiresIn =
    tokens.expires_in && tokens.expires_in > 0 ? tokens.expires_in : 3600
  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    email: tokens.account?.email_address ?? current?.email,
    accountId:
      tokens.account?.uuid ?? tokens.organization?.uuid ?? current?.accountId,
    subscriptionType: current?.subscriptionType,
  }
}

async function readTokenResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function describeTokenError(status: number, value: unknown): string {
  const record =
    value && typeof value === "object" ?
      (value as Record<string, unknown>)
    : undefined
  const error =
    typeof record?.error === "string" ? record.error
    : typeof record?.error_description === "string" ? record.error_description
    : undefined
  return error ?
      `Claude rejected the sign-in (HTTP ${status}): ${error}`
    : `Claude rejected the sign-in (HTTP ${status}).`
}

export async function exchangeClaudeAuthorizationCode(
  input: {
    code: string
    state: string
    codeVerifier: string
  },
  options: ClaudeOAuthDependencies = {},
): Promise<ClaudeOAuthCredentials> {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const response = await fetcher(CLAUDE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      code: input.code,
      grant_type: "authorization_code",
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
      code_verifier: input.codeVerifier,
      state: input.state,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new ClaudeOAuthError(
      describeTokenError(response.status, await readTokenResponse(response)),
    )
  }
  const parsed = tokenResponseSchema.safeParse(
    await readTokenResponse(response),
  )
  if (!parsed.success) {
    throw new ClaudeOAuthError(
      "Claude returned an unexpected token response. Sign in again.",
    )
  }
  return credentialsFromTokenResponse(parsed.data, undefined, now())
}

export async function refreshClaudeCredentials(
  credentials: ClaudeOAuthCredentials,
  options: ClaudeOAuthDependencies = {},
): Promise<ClaudeOAuthCredentials> {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const response = await fetcher(CLAUDE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new ClaudeOAuthError(
      describeTokenError(response.status, await readTokenResponse(response)),
    )
  }
  const parsed = tokenResponseSchema.safeParse(
    await readTokenResponse(response),
  )
  if (!parsed.success) {
    throw new ClaudeOAuthError(
      "Claude returned an unexpected refresh response. Sign in again.",
    )
  }
  return credentialsFromTokenResponse(parsed.data, credentials, now())
}

async function loadFreshClaudeCredentials(
  options: ClaudeOAuthDependencies,
  forceRefresh: boolean,
): Promise<ClaudeOAuthCredentials | null> {
  const path = credentialPath(options)
  const now = options.now ?? Date.now
  const current = await readClaudeCredentialsAt(path)
  if (!current) return null
  if (!forceRefresh && !isClaudeCredentialsExpired(current, now())) {
    return current
  }

  return await withCredentialFileLock(`${path}.refresh`, async () => {
    const latest = await readClaudeCredentialsAt(path)
    if (!latest) return null
    if (!forceRefresh && !isClaudeCredentialsExpired(latest, now())) {
      return latest
    }
    let refreshed: ClaudeOAuthCredentials
    try {
      refreshed = await refreshClaudeCredentials(latest, options)
    } catch (error) {
      // A revoked or reused refresh token is terminal: drop the unusable
      // credentials so the dashboard shows "signed out" instead of hammering
      // Anthropic with a token that will never work again.
      if (
        error instanceof ClaudeOAuthError
        && /invalid_grant|reused|revoked/iu.test(error.message)
      ) {
        await clearClaudeCredentialsAt(path)
        return null
      }
      throw error
    }
    await writeClaudeCredentialsAt(path, refreshed)
    return refreshed
  })
}

/**
 * Returns a usable access token, refreshing it shortly before expiry. Returns
 * null when no account is signed in.
 */
export async function getClaudeAccessToken(
  options: ClaudeOAuthDependencies & { forceRefresh?: boolean } = {},
): Promise<string | null> {
  const credentials = await loadFreshClaudeCredentials(
    options,
    options.forceRefresh === true,
  )
  return credentials?.accessToken ?? null
}

export async function getClaudeCredentials(
  options: ClaudeOAuthDependencies = {},
): Promise<ClaudeOAuthCredentials | null> {
  return await loadFreshClaudeCredentials(options, false)
}

export async function fetchClaudeOAuthUsage(
  options: ClaudeOAuthDependencies & { signal?: AbortSignal } = {},
): Promise<unknown> {
  const fetcher = options.fetch ?? fetch
  const request = async (accessToken: string): Promise<Response> => {
    const timeout = AbortSignal.timeout(USAGE_TIMEOUT_MS)
    return await fetcher(CLAUDE_OAUTH_USAGE_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        "anthropic-version": CLAUDE_OAUTH_VERSION,
        "user-agent": CLAUDE_OAUTH_USER_AGENT,
        "x-app": "cli",
        accept: "application/json",
      },
      signal:
        options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      redirect: "error",
    })
  }

  let accessToken = await getClaudeAccessToken(options)
  if (!accessToken) {
    throw new ClaudeOAuthError(
      "Claude is not signed in. Sign in from the dashboard first.",
    )
  }
  let response = await request(accessToken)
  if (response.status === 401) {
    accessToken = await getClaudeAccessToken({
      ...options,
      forceRefresh: true,
    })
    if (!accessToken) {
      throw new ClaudeOAuthError(
        "Claude rejected the stored sign-in. Sign in again.",
      )
    }
    response = await request(accessToken)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new ClaudeOAuthError(
      `Claude usage request failed (HTTP ${response.status}).`,
    )
  }
  return await response.json()
}

export function createClaudeOAuthLogin(
  dependencies: ClaudeOAuthDependencies = {},
) {
  const now = dependencies.now ?? Date.now
  const fetcher = dependencies.fetch ?? fetch
  const path = credentialPath(dependencies)
  const pending = new Map<string, PendingLogin>()

  const prune = (): void => {
    const deadline = now()
    for (const [flowId, login] of pending) {
      if (login.expiresAt <= deadline) pending.delete(flowId)
    }
  }

  const status = async (): Promise<ClaudeOAuthStatus> => {
    try {
      const credentials = await readClaudeCredentialsAt(path)
      if (!credentials) {
        return { available: true, loggedIn: false }
      }
      return {
        available: true,
        loggedIn: true,
        authMethod: "oauth_token",
        email: credentials.email,
        subscriptionType: credentials.subscriptionType,
        expiresAt: credentials.expiresAt,
      }
    } catch (error) {
      return {
        available: true,
        loggedIn: false,
        error:
          error instanceof Error ?
            error.message
          : "The stored Claude sign-in could not be read.",
      }
    }
  }

  const start = (): ClaudeOAuthLoginStart => {
    prune()
    if (pending.size >= MAX_PENDING_LOGINS) {
      const oldest = pending.keys().next().value
      if (oldest !== undefined) pending.delete(oldest)
    }
    const flowId = randomUUID()
    const state = base64Url(randomBytes(32))
    const { codeVerifier, codeChallenge } = createPkcePair()
    const expiresAt = now() + LOGIN_TTL_MS
    pending.set(flowId, { state, codeVerifier, expiresAt })
    return {
      flowId,
      authUrl: buildClaudeAuthorizeUrl({ state, codeChallenge }),
      expiresAt,
    }
  }

  const submit = async (
    flowId: unknown,
    input: unknown,
  ): Promise<ClaudeOAuthStatus> => {
    if (typeof flowId !== "string" || !flowId) {
      throw new ClaudeOAuthError(
        "Missing sign-in session. Start the Claude sign-in again.",
      )
    }
    if (typeof input !== "string" || !input.trim()) {
      throw new ClaudeOAuthError(
        "Paste the login code shown after signing in with Claude.",
      )
    }

    prune()
    const login = pending.get(flowId)
    if (!login) {
      throw new ClaudeOAuthError(
        "This Claude sign-in has expired or was already used. Start it again.",
      )
    }
    // One attempt per session: an authorization code can only be used once.
    pending.delete(flowId)

    const parsed = parseClaudeSubmittedCode(input)
    if (!parsed) {
      throw new ClaudeOAuthError(
        "That is not a login code. Copy the code shown after signing in.",
      )
    }
    if (parsed.state && parsed.state !== login.state) {
      throw new ClaudeOAuthError(
        "This login code belongs to a different sign-in attempt. Start again.",
      )
    }

    let credentials: ClaudeOAuthCredentials
    try {
      credentials = await exchangeClaudeAuthorizationCode(
        {
          code: parsed.code,
          state: login.state,
          codeVerifier: login.codeVerifier,
        },
        { fetch: fetcher, now },
      )
    } catch (error) {
      if (error instanceof ClaudeOAuthError) throw error
      throw new ClaudeOAuthError(
        "Could not reach Anthropic to finish the sign-in. Try again.",
        { cause: error },
      )
    }

    await writeClaudeCredentialsAt(path, credentials)
    return await status()
  }

  const cancel = (flowId: string): boolean => pending.delete(flowId)

  const logout = async (): Promise<ClaudeOAuthStatus> => {
    await clearClaudeCredentialsAt(path)
    return await status()
  }

  return {
    start,
    submit,
    cancel,
    status,
    logout,
    pendingCount: () => pending.size,
  }
}
