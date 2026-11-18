import consola from "consola"
import { createHash } from "node:crypto"

import { ChatGPTWebError, createChatGPTWebUpstreamError } from "./errors"

/**
 * ChatGPT web login through the browser session cookie.
 *
 * The user signs in at chatgpt.com once and stores the session cookie
 * (`__Secure-next-auth.session-token`) in the provider config. Like the web
 * app after a page load, the gateway exchanges it at `/api/auth/session` for a
 * short-lived access token. The cookies the server sets in return (rotated
 * session token, device id, Cloudflare cookies) are kept in a jar, so later
 * requests continue the same session the way a browser would.
 */

export const CHATGPT_SESSION_COOKIE = "__Secure-next-auth.session-token"

const SESSION_PATH = "/api/auth/session"
const SESSION_TIMEOUT_MS = 20_000
/** Exchange again shortly before the access token expires. */
const REFRESH_MARGIN_MS = 5 * 60_000
/** Re-validate the login regularly even when the token lives for days. */
const MAX_SESSION_AGE_MS = 60 * 60_000
const FALLBACK_TOKEN_TTL_MS = 10 * 60_000
const MAX_CACHED_LOGINS = 16
const MAX_JAR_COOKIES = 64
/**
 * A cookie that chatgpt.com rejected is not sent again for this long, so
 * model listings and retries cannot flood the login endpoint. A newly pasted
 * cookie is a different login and is tried right away.
 */
const REJECTED_LOGIN_BACKOFF_MS = 60_000

const COOKIE_NAME_PATTERN = /^[\w!#$%&'*+\-.^`|~]+$/u
// Printable ASCII without whitespace and `;`, so no value can split the header.
const COOKIE_VALUE_PATTERN = /^[!-:<-~]+$/u
// Cloudflare binds these to the IP and fingerprint of the browser they were
// issued to; the gateway receives its own from the server instead.
const BROWSER_BOUND_COOKIE_PATTERN =
  /^(?:cf_clearance|__cf_bm|__cflb|_cfuvid|cf_chl_.*)$/u

export const CHATGPT_LOGIN_HINT =
  "Sign in at chatgpt.com, copy the cookie __Secure-next-auth.session-token (or the whole Cookie header) and paste it in the dashboard: Admin → Providers → chatgpt → Cookie."

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function addCookie(
  cookies: Map<string, string>,
  name: unknown,
  value: unknown,
): void {
  if (typeof name !== "string" || typeof value !== "string") return
  const cookieName = name.trim()
  const cookieValue = value.trim()
  if (
    !COOKIE_NAME_PATTERN.test(cookieName)
    || !COOKIE_VALUE_PATTERN.test(cookieValue)
    || BROWSER_BOUND_COOKIE_PATTERN.test(cookieName)
  ) {
    return
  }
  cookies.set(cookieName, cookieValue)
}

function parseCookieExport(
  parsed: unknown,
  cookies: Map<string, string>,
): void {
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    if ("name" in entry && "value" in entry) {
      const domain = typeof entry.domain === "string" ? entry.domain : ""
      if (!domain || domain.includes("chatgpt.com")) {
        addCookie(cookies, entry.name, entry.value)
      }
      continue
    }
    for (const [name, value] of Object.entries(entry)) {
      addCookie(cookies, name, value)
    }
  }
}

/**
 * Reads the cookie the user pasted: a `Cookie` header (`a=1; b=2`, optionally
 * prefixed with `Cookie:`), a JSON export of a cookie editor extension, or
 * just the value of the session token.
 */
export function parseChatGPTCookieInput(input: string): Map<string, string> {
  const cookies = new Map<string, string>()
  const text = input.trim().replace(/^cookie:\s*/iu, "")
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      parseCookieExport(JSON.parse(text) as unknown, cookies)
    } catch {
      // A damaged export yields no cookies, so the caller reports the missing
      // session token instead of sending garbage as one.
    }
    return cookies
  }
  if (!text.includes("=") && COOKIE_VALUE_PATTERN.test(text)) {
    addCookie(cookies, CHATGPT_SESSION_COOKIE, text)
    return cookies
  }
  for (const part of text.split(/;|\r?\n/u)) {
    const separator = part.indexOf("=")
    if (separator <= 0) continue
    addCookie(cookies, part.slice(0, separator), part.slice(separator + 1))
  }
  return cookies
}

/** The session token, joined from its chunks when it was split. */
function readSessionToken(
  cookies: ReadonlyMap<string, string>,
): string | undefined {
  const whole = cookies.get(CHATGPT_SESSION_COOKIE)
  if (whole) return whole
  const chunks: Array<string> = []
  for (let index = 0; ; index++) {
    const chunk = cookies.get(`${CHATGPT_SESSION_COOKIE}.${index}`)
    if (chunk === undefined) break
    chunks.push(chunk)
  }
  return chunks.length > 0 ? chunks.join("") : undefined
}

function isExpiredSetCookie(attributes: Array<string>, now: number): boolean {
  for (const attribute of attributes) {
    const separator = attribute.indexOf("=")
    const key = (separator === -1 ? attribute : attribute.slice(0, separator))
      .trim()
      .toLowerCase()
    const value = separator === -1 ? "" : attribute.slice(separator + 1).trim()
    if (key === "max-age" && Number(value) <= 0) return true
    if (key === "expires") {
      const expiresAt = Date.parse(value)
      if (Number.isFinite(expiresAt) && expiresAt <= now) return true
    }
  }
  return false
}

/** Cookies of one ChatGPT login, updated from responses like a browser. */
export class ChatGPTCookieJar {
  private readonly cookies: Map<string, string>

  constructor(initial: ReadonlyMap<string, string> = new Map()) {
    this.cookies = new Map(initial)
  }

  get(name: string): string | undefined {
    return this.cookies.get(name)
  }

  get size(): number {
    return this.cookies.size
  }

  /** The `Cookie` request header. */
  header(): string {
    return [...this.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ")
  }

  /** Applies the `Set-Cookie` headers of a chatgpt.com response. */
  absorb(headers: Headers, now = Date.now()): void {
    for (const line of headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";")
      const separator = pair.indexOf("=")
      if (separator <= 0) continue
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      if (!COOKIE_NAME_PATTERN.test(name)) continue
      if (
        !value
        || !COOKIE_VALUE_PATTERN.test(value)
        || isExpiredSetCookie(attributes, now)
      ) {
        this.cookies.delete(name)
        continue
      }
      if (this.cookies.size >= MAX_JAR_COOKIES && !this.cookies.has(name)) {
        continue
      }
      this.cookies.set(name, value)
    }
  }
}

export interface ChatGPTCookieLogin {
  accessToken: string
  accountId?: string
  /** Stable, non-secret key of this login (hash of the configured cookie). */
  identityKey: string
  jar: ChatGPTCookieJar
  planType?: string
}

interface CachedLogin {
  /** A rejected login, answered from the cache until `until`. */
  failure?: { error: ChatGPTWebError; until: number }
  jar: ChatGPTCookieJar
  login?: ChatGPTCookieLogin
  refreshAt: number
}

const logins = new Map<string, CachedLogin>()
const pendingExchanges = new Map<string, Promise<ChatGPTCookieLogin>>()

export function clearChatGPTCookieLogins(): void {
  logins.clear()
  pendingExchanges.clear()
}

/** Drops the cached access token, e.g. after the backend rejected it. */
export function forgetChatGPTCookieLogin(identityKey: string): void {
  const cached = logins.get(identityKey)
  if (cached) {
    cached.login = undefined
    cached.refreshAt = 0
  }
}

export function readJwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown
    return isRecord(claims) && typeof claims.exp === "number" ?
        claims.exp * 1000
      : undefined
  } catch {
    return undefined
  }
}

function identityKeyOf(origin: string, sessionToken: string): string {
  const digest = createHash("sha256")
    .update(`${origin}\n${sessionToken}`)
    .digest("hex")
  return `cookie:${digest.slice(0, 24)}`
}

export interface ChatGPTCookieLoginOptions {
  fetch?: typeof globalThis.fetch
  now?: () => number
  /** e.g. `https://chatgpt.com` */
  origin: string
  signal?: AbortSignal
  userAgent: string
}

function createSessionSignal(clientSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(SESSION_TIMEOUT_MS)
  return clientSignal ? AbortSignal.any([clientSignal, timeout]) : timeout
}

function createLoginExpiredError(detail: string): ChatGPTWebError {
  return new ChatGPTWebError(
    401,
    "chatgpt_login_expired",
    `The ChatGPT login is invalid or has expired (${detail}). ${CHATGPT_LOGIN_HINT}`,
  )
}

async function exchangeSessionCookie(
  identityKey: string,
  cached: CachedLogin,
  options: ChatGPTCookieLoginOptions,
): Promise<ChatGPTCookieLogin> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const response = await fetchImpl(`${options.origin}${SESSION_PATH}`, {
    headers: {
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      cookie: cached.jar.header(),
      referer: `${options.origin}/`,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent": options.userAgent,
    },
    method: "GET",
    signal: createSessionSignal(options.signal),
  })
  cached.jar.absorb(response.headers, now())
  if (!response.ok) {
    throw await createChatGPTWebUpstreamError(response, "login session")
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw createLoginExpiredError("the session endpoint answered without JSON")
  }
  const accessToken =
    isRecord(body) && typeof body.accessToken === "string" ?
      body.accessToken.trim()
    : ""
  if (!accessToken) {
    throw createLoginExpiredError("chatgpt.com returned no access token")
  }
  const account =
    isRecord(body) && isRecord(body.account) ? body.account : undefined
  const login: ChatGPTCookieLogin = {
    accessToken,
    accountId:
      typeof account?.id === "string" && account.id ? account.id : undefined,
    identityKey,
    jar: cached.jar,
    planType:
      typeof account?.planType === "string" && account.planType ?
        account.planType
      : undefined,
  }

  const issuedAt = now()
  const expiresAt =
    readJwtExpiry(accessToken) ?? issuedAt + FALLBACK_TOKEN_TTL_MS
  cached.login = login
  cached.refreshAt = Math.min(
    expiresAt - REFRESH_MARGIN_MS,
    issuedAt + MAX_SESSION_AGE_MS,
  )
  consola.info(
    `chatgpt web: signed in with the session cookie (plan: ${login.planType ?? "unknown"})`,
  )
  return login
}

function getCachedLogin(identityKey: string, cookies: Map<string, string>) {
  const existing = logins.get(identityKey)
  if (existing) {
    // Most recently used last, so the oldest login is evicted first.
    logins.delete(identityKey)
    logins.set(identityKey, existing)
    return existing
  }
  if (logins.size >= MAX_CACHED_LOGINS) {
    const oldest = logins.keys().next().value
    if (oldest !== undefined) logins.delete(oldest)
  }
  const created: CachedLogin = {
    jar: new ChatGPTCookieJar(cookies),
    refreshAt: 0,
  }
  logins.set(identityKey, created)
  return created
}

/**
 * Returns the access token of the configured ChatGPT login, exchanging the
 * session cookie when there is no valid cached token.
 */
export async function getChatGPTCookieLogin(
  cookieInput: string,
  options: ChatGPTCookieLoginOptions,
): Promise<ChatGPTCookieLogin> {
  const cookies = parseChatGPTCookieInput(cookieInput)
  const sessionToken = readSessionToken(cookies)
  if (!sessionToken) {
    throw new ChatGPTWebError(
      401,
      "chatgpt_cookie_invalid",
      `The ChatGPT cookie in the provider config contains no ${CHATGPT_SESSION_COOKIE}. ${CHATGPT_LOGIN_HINT}`,
    )
  }
  const identityKey = identityKeyOf(options.origin, sessionToken)
  const cached = getCachedLogin(identityKey, cookies)
  const now = options.now ?? Date.now
  if (cached.login && cached.refreshAt > now()) return cached.login
  if (cached.failure && cached.failure.until > now()) throw cached.failure.error

  const pending = pendingExchanges.get(identityKey)
  if (pending) return await pending
  const exchange = exchangeSessionCookie(identityKey, cached, options)
    .then(
      (login) => {
        cached.failure = undefined
        return login
      },
      (error: unknown) => {
        if (
          error instanceof ChatGPTWebError
          && (error.status === 401 || error.status === 403)
        ) {
          cached.failure = { error, until: now() + REJECTED_LOGIN_BACKOFF_MS }
        }
        throw error
      },
    )
    .finally(() => {
      pendingExchanges.delete(identityKey)
    })
  pendingExchanges.set(identityKey, exchange)
  return await exchange
}
