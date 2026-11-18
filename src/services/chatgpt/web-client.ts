import { createHash, randomUUID } from "node:crypto"

import type { ResolvedProviderConfig } from "~/lib/config"

import {
  CHATGPT_LOGIN_HINT,
  forgetChatGPTCookieLogin,
  getChatGPTCookieLogin,
  type ChatGPTCookieJar,
} from "./cookie-session"
import { ChatGPTWebError } from "./errors"

/**
 * Client of the ChatGPT web backend (`chatgpt.com/backend-api`).
 *
 * It signs in with the user's own ChatGPT web login: the browser session
 * cookie from the provider config, or alternatively a ChatGPT access token as
 * the provider's API key. The Codex accounts are never used, so chatgpt/*
 * requests cannot consume the Codex quota. Requests look like the browser app
 * so that the backend applies the regular web conversation rules.
 */
export const CHATGPT_WEB_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"

const DEFAULT_BACKEND_URL = "https://chatgpt.com/backend-api"
const MAX_DEVICE_IDS = 32

export interface ChatGPTWebSession {
  accessToken: string
  accountId?: string
  /** e.g. `https://chatgpt.com/backend-api` */
  backendUrl: string
  /** Cookies of a cookie login, sent with and updated by every request. */
  cookieJar?: ChatGPTCookieJar
  deviceId: string
  /** Stable, non-secret key of the login (catalog cache, device id). */
  identityKey: string
  /** e.g. `https://chatgpt.com` */
  origin: string
}

export type ChatGPTWebCredentials = Pick<
  ResolvedProviderConfig,
  "apiKey" | "baseUrl" | "cookie"
>

export interface ResolveChatGPTWebSessionOptions {
  fetch?: typeof globalThis.fetch
  now?: () => number
  signal?: AbortSignal
}

// One stable device id per login and process, like a single browser profile.
const deviceIds = new Map<string, string>()

function getDeviceId(identityKey: string): string {
  const existing = deviceIds.get(identityKey)
  if (existing) return existing
  if (deviceIds.size >= MAX_DEVICE_IDS) {
    const oldest = deviceIds.keys().next().value
    if (oldest !== undefined) deviceIds.delete(oldest)
  }
  const created = randomUUID()
  deviceIds.set(identityKey, created)
  return created
}

export function normalizeChatGPTBackendUrl(
  baseUrl: string | undefined,
): string {
  const trimmed = (baseUrl ?? "").trim().replace(/\/+$/u, "")
  if (!trimmed) return DEFAULT_BACKEND_URL
  return trimmed.endsWith("/backend-api") ? trimmed : `${trimmed}/backend-api`
}

/** Signs in with the configured ChatGPT web login. */
export async function resolveChatGPTWebSession(
  credentials: ChatGPTWebCredentials,
  options: ResolveChatGPTWebSessionOptions = {},
): Promise<ChatGPTWebSession> {
  const backendUrl = normalizeChatGPTBackendUrl(credentials.baseUrl)
  const origin = new URL(backendUrl).origin

  const cookie = credentials.cookie?.trim()
  if (cookie) {
    const login = await getChatGPTCookieLogin(cookie, {
      fetch: options.fetch,
      now: options.now,
      origin,
      signal: options.signal,
      userAgent: CHATGPT_WEB_USER_AGENT,
    })
    return {
      accessToken: login.accessToken,
      accountId: login.accountId,
      backendUrl,
      cookieJar: login.jar,
      deviceId: login.jar.get("oai-did") ?? getDeviceId(login.identityKey),
      identityKey: login.identityKey,
      origin,
    }
  }

  const accessToken = credentials.apiKey.trim()
  if (accessToken) {
    const digest = createHash("sha256").update(accessToken).digest("hex")
    const identityKey = `token:${digest.slice(0, 24)}`
    return {
      accessToken,
      backendUrl,
      deviceId: getDeviceId(identityKey),
      identityKey,
      origin,
    }
  }

  throw new ChatGPTWebError(
    401,
    "chatgpt_login_required",
    `chatgpt/* models use your own ChatGPT web login, not the Codex accounts. ${CHATGPT_LOGIN_HINT}`,
  )
}

/** Drops a cached login whose access token the backend rejected. */
export function forgetChatGPTWebSession(session: ChatGPTWebSession): void {
  forgetChatGPTCookieLogin(session.identityKey)
}

/** Keeps the cookies a backend response sets, like a browser. */
export function rememberChatGPTWebCookies(
  session: ChatGPTWebSession,
  response: Response,
): void {
  session.cookieJar?.absorb(response.headers)
}

export function buildChatGPTWebHeaders(
  session: ChatGPTWebSession,
  path: string,
  extra: Record<string, string | undefined> = {},
): Headers {
  const headers = new Headers({
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    authorization: `Bearer ${session.accessToken}`,
    "oai-device-id": session.deviceId,
    "oai-language": "en-US",
    origin: session.origin,
    referer: `${session.origin}/`,
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": CHATGPT_WEB_USER_AGENT,
    "x-openai-target-path": `/backend-api${path}`,
    "x-openai-target-route": `/backend-api${path}`,
  })
  if (session.accountId) headers.set("chatgpt-account-id", session.accountId)
  const cookie = session.cookieJar?.header()
  if (cookie) headers.set("cookie", cookie)
  for (const [name, value] of Object.entries(extra)) {
    if (value) headers.set(name, value)
  }
  return headers
}

export function resolveChatGPTWebUrl(
  session: ChatGPTWebSession,
  path: string,
): string {
  return `${session.backendUrl}${path}`
}

/** Combines an optional client abort signal with a request timeout. */
export function createChatGPTWebSignal(
  timeoutMs: number,
  clientSignal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return clientSignal ? AbortSignal.any([clientSignal, timeout]) : timeout
}
