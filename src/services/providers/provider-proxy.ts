import consola from "consola"
import { randomUUID } from "node:crypto"
import {
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici"

import {
  getUpstreamTransportConfig,
  normalizeProviderBaseUrl,
  type ResolvedProviderConfig,
} from "~/lib/config"
import {
  noteProviderApiKeyResult,
  selectProviderApiKey,
} from "~/lib/provider-key-pool"
import {
  CLAUDE_OAUTH_BETA,
  CLAUDE_OAUTH_USER_AGENT,
  CLAUDE_OAUTH_VERSION,
} from "~/lib/claude-code/oauth"
import { getGrokBuildVersion } from "~/lib/grok-build"
import { XAI_API_BASE_URL } from "~/lib/oauth/xai"
import {
  requestContext,
  setPluginRequestActualModel,
} from "~/lib/request-context"
import { createTimeoutDispatcher } from "~/lib/timeout-dispatcher"
import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type { ResponsesPayload } from "~/lib/types/responses"
import type { GoogleModelsResponse } from "~/lib/types/google"
import { createChatGPTWebChatCompletion } from "~/services/chatgpt/chat-completions"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"
import { getWebAdapter } from "~/services/web/registry"
import { webErrorResponse } from "~/services/web/stream"
import { WebSessionError } from "~/services/web/types"

const OPENCODE_GO_PROVIDER_NAME = "opencode-go"
const OPENCODE_SESSION_HEADER = "x-opencode-session"

const SHARED_FORWARDABLE_HEADERS = ["accept", "user-agent"] as const

const ANTHROPIC_FORWARDABLE_HEADERS = [
  "anthropic-version",
  "anthropic-beta",
] as const

const STRIPPED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const

export function resolveProviderEndpointUrl(
  providerConfig: ResolvedProviderConfig,
  endpoint: string,
): string {
  if (providerConfig.name === OPENCODE_GO_PROVIDER_NAME) {
    const base = normalizeProviderBaseUrl(providerConfig.baseUrl)
    const apiBase = /\/v\d+(?:alpha|beta)?$/u.test(base) ? base : `${base}/v1`
    return `${apiBase}/${endpoint}`
  }
  if (providerConfig.type === "google") {
    const base = providerConfig.baseUrl.replace(/\/+$/u, "")
    const apiBase =
      /\/v\d+(?:alpha|beta)?$/u.test(base) ? base : `${base}/v1beta`
    return `${apiBase}/${endpoint}`
  }
  const apiBaseUrl =
    providerConfig.modelsDevProviderId ?
      providerConfig.baseUrl.replace(/\/(?:chat\/completions|responses)$/u, "")
    : `${providerConfig.baseUrl}/v1`
  return `${apiBaseUrl}/${endpoint}`
}

/**
 * Selects the API key for one upstream request. With a single key (or none)
 * this is just `providerConfig.apiKey`; with a pool it rotates round-robin and
 * returns the chosen key so the caller can report the upstream result.
 */
export function selectProviderRequestApiKey(
  providerConfig: ResolvedProviderConfig,
): { apiKey: string; key?: string } {
  const pool = providerConfig.keyPool
  if (!pool || pool.length === 0) {
    return { apiKey: providerConfig.apiKey }
  }
  const key = selectProviderApiKey(providerConfig.name, pool)
  return { apiKey: key ?? providerConfig.apiKey, key }
}

export function buildProviderUpstreamHeaders(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
  apiKey: string = providerConfig.apiKey,
): Record<string, string> {
  const authHeaders: Record<string, string> = {}
  if (providerConfig.authType === "cookie") {
    // Cookie-based authentication for ChatGPT passthrough
    if (providerConfig.cookie) {
      authHeaders.cookie = providerConfig.cookie
    }
  } else if (
    providerConfig.authType === "x-api-key"
    || providerConfig.authType === "x-goog-api-key"
  ) {
    authHeaders[providerConfig.authType] = apiKey
  } else {
    authHeaders.authorization = `Bearer ${apiKey}`
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...authHeaders,
  }

  for (const headerName of SHARED_FORWARDABLE_HEADERS) {
    const headerValue = requestHeaders.get(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  if (providerConfig.type !== "anthropic") {
    return headers
  }

  if (providerConfig.modelsDevProviderId) {
    headers["anthropic-version"] = "2023-06-01"
  }

  for (const headerName of ANTHROPIC_FORWARDABLE_HEADERS) {
    const headerValue = requestHeaders.get(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  if (
    providerConfig.name === "anthropic"
    && providerConfig.authType === "oauth2"
  ) {
    // The Claude subscription token is only accepted with the OAuth beta and
    // a CLI-like client identity. Order matters: keep oauth-2025-04-20 first.
    headers["anthropic-version"] = CLAUDE_OAUTH_VERSION
    headers["anthropic-beta"] = mergeBetaHeaders(headers["anthropic-beta"], [
      CLAUDE_OAUTH_BETA,
      "claude-code-20250219",
    ])
    headers["x-app"] = "cli"
    headers["user-agent"] = CLAUDE_OAUTH_USER_AGENT
  }

  return headers
}

function mergeBetaHeaders(
  current: string | undefined,
  required: Array<string>,
): string {
  const values = new Set(
    (current ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )
  for (const value of required) values.add(value)
  return [...values].join(",")
}

export const resolveOpencodeMessagesSession = (): string | undefined => {
  const store = requestContext.getStore()
  // Keep sibling subagents on the root session so opencode-go routes them to the
  // same prompt cache group, matching the chat completions/responses flows.
  const rootSessionId = store?.rootSessionId?.trim()
  if (rootSessionId) {
    return rootSessionId
  }

  const sessionAffinity = store?.sessionAffinity?.trim()
  if (sessionAffinity) {
    return sessionAffinity
  }

  return undefined
}

export const applyOpencodeSessionHeader = (
  providerConfig: ResolvedProviderConfig,
  headers: Record<string, string>,
  session: string | undefined,
): void => {
  if (providerConfig.name !== OPENCODE_GO_PROVIDER_NAME || !session) {
    return
  }
  headers[OPENCODE_SESSION_HEADER] = session
}

async function applyXaiGrokBuildHeaders(
  providerConfig: ResolvedProviderConfig,
  headers: Record<string, string>,
  payload: ResponsesPayload,
): Promise<void> {
  if (
    providerConfig.name !== "xai"
    || providerConfig.authType !== "oauth2"
    || new URL(providerConfig.baseUrl).origin !== XAI_API_BASE_URL
  ) {
    return
  }

  const cacheKey = payload.prompt_cache_key
  const sessionId =
    cacheKey?.trim() ?
      cacheKey
    : requestContext.getStore()?.sessionAffinity?.trim()
  if (!sessionId) {
    throw new Error(
      "xAI OAuth Responses requests require prompt_cache_key or session affinity",
    )
  }
  headers["x-xai-token-auth"] = "xai-grok-cli"
  headers["x-authenticateresponse"] = "authenticate-response"
  headers["x-grok-client-version"] = await getGrokBuildVersion()
  headers["x-grok-client-identifier"] = "grok-shell"
  headers["x-grok-client-mode"] = "headless"
  headers["x-grok-model-override"] = payload.model
  headers["x-grok-conv-id"] = sessionId
  headers["x-grok-session-id"] = sessionId
  headers["x-grok-req-id"] = randomUUID()
}

export function createProviderProxyResponse(
  upstreamResponse: Response,
  body?: ReadableStream<Uint8Array> | null,
): Response {
  return new Response(body ?? upstreamResponse.body, {
    headers: createProviderProxyResponseHeaders(upstreamResponse.headers),
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  })
}

export function createProviderProxyResponseHeaders(
  upstreamHeaders: Headers,
): Headers {
  const headers = new Headers(upstreamHeaders)

  for (const headerName of STRIPPED_RESPONSE_HEADERS) {
    headers.delete(headerName)
  }

  return headers
}

const MAX_PROVIDER_KEY_ATTEMPTS = 3

interface ProviderForwardOptions {
  method?: string
  body?: RequestInit["body"]
  clientSignal?: AbortSignal
  headersTimeoutMs: number
  streamInactivityTimeoutMs: number
  /**
   * Extra headers that depend on the chosen key (session affinity, xAI client
   * metadata). Runs once per attempt with the selected key.
   */
  decorateHeaders?: (
    headers: Record<string, string>,
    apiKey: string,
  ) => void | Promise<void>
  /**
   * Retry with another key after an upstream 429. Only safe for replayable
   * bodies, so callers that stream a request body must disable it.
   */
  retryOnRateLimit?: boolean
}

/**
 * Sends one upstream request, rotating through the provider's API-key pool.
 * A 429 is retried with the next key (bounded by the pool size) because the
 * upstream rejected the request before doing any work. 401/403 responses mark
 * the key as cooling down so later requests skip it.
 */
async function fetchProviderUpstream(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
  url: string,
  options: ProviderForwardOptions,
): Promise<Response> {
  const pool = providerConfig.keyPool ?? []
  const attempts =
    options.retryOnRateLimit !== false && pool.length > 1 ?
      Math.min(pool.length, MAX_PROVIDER_KEY_ATTEMPTS)
    : 1
  const seen = new Set<string>()
  let response: Response | null = null

  for (let attempt = 0; attempt < attempts; attempt++) {
    const { apiKey, key } = selectProviderRequestApiKey(providerConfig)
    if (seen.has(apiKey)) break
    seen.add(apiKey)

    const headers = buildProviderUpstreamHeaders(
      providerConfig,
      requestHeaders,
      apiKey,
    )
    await options.decorateHeaders?.(headers, apiKey)

    response = await fetchUpstreamWithLifecycle(
      url,
      { method: options.method ?? "POST", headers, body: options.body },
      {
        clientSignal: options.clientSignal,
        headersTimeoutMs: options.headersTimeoutMs,
        streamInactivityTimeoutMs: options.streamInactivityTimeoutMs,
      },
    )
    noteProviderApiKeyResult(providerConfig.name, key, response.status)
    if (response.status !== 429) break
  }

  if (!response) {
    throw new Error("Provider upstream request was not attempted")
  }
  return response
}

export async function forwardProviderMessages(
  providerConfig: ResolvedProviderConfig,
  payload: AnthropicMessagesPayload,
  requestHeaders: Headers,
  options: { clientSignal?: AbortSignal } = {},
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  const transportConfig = getUpstreamTransportConfig()
  setPluginRequestActualModel(payload.model, providerConfig.name)
  return await fetchProviderUpstream(
    providerConfig,
    requestHeaders,
    resolveProviderEndpointUrl(providerConfig, "messages"),
    {
      body: JSON.stringify(payload),
      clientSignal: options.clientSignal,
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
      decorateHeaders: (headers) => {
        applyOpencodeSessionHeader(
          providerConfig,
          headers,
          resolveOpencodeMessagesSession(),
        )
      },
    },
  )
}

export async function forwardProviderChatCompletions(
  providerConfig: ResolvedProviderConfig,
  payload: ChatCompletionsPayload,
  requestHeaders: Headers,
  options: { clientSignal?: AbortSignal } = {},
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  if (providerConfig.type === "chatgpt") {
    // ChatGPT web has no Chat Completions API; the adapter talks to the web
    // conversation endpoint and answers in Chat Completions format.
    setPluginRequestActualModel(payload.model, providerConfig.name)
    return await createChatGPTWebChatCompletion(providerConfig, payload, {
      clientSignal: options.clientSignal,
    })
  }
  if (providerConfig.type === "web") {
    const adapter = getWebAdapter(providerConfig.webAdapter)
    if (!adapter) {
      return webErrorResponse(
        400,
        "web_adapter_unknown",
        `Provider '${providerConfig.name}' has no known web adapter '${providerConfig.webAdapter ?? ""}'.`,
      )
    }
    setPluginRequestActualModel(payload.model, providerConfig.name)
    try {
      return await adapter.chatCompletion(providerConfig, payload, {
        clientSignal: options.clientSignal,
      })
    } catch (error) {
      if (error instanceof WebSessionError) {
        return webErrorResponse(error.status, error.code, error.message)
      }
      throw error
    }
  }
  const transportConfig = getUpstreamTransportConfig()
  setPluginRequestActualModel(payload.model, providerConfig.name)
  return await fetchProviderUpstream(
    providerConfig,
    requestHeaders,
    resolveProviderEndpointUrl(providerConfig, "chat/completions"),
    {
      body: JSON.stringify(payload),
      clientSignal: options.clientSignal,
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
      decorateHeaders: (headers) => {
        applyOpencodeSessionHeader(
          providerConfig,
          headers,
          payload.prompt_cache_key?.trim() || undefined,
        )
      },
    },
  )
}

export async function forwardProviderResponses(
  providerConfig: ResolvedProviderConfig,
  payload: ResponsesPayload,
  requestHeaders: Headers,
  options: { clientSignal?: AbortSignal } = {},
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  const transportConfig = getUpstreamTransportConfig()
  setPluginRequestActualModel(payload.model, providerConfig.name)
  return await fetchProviderUpstream(
    providerConfig,
    requestHeaders,
    resolveProviderEndpointUrl(providerConfig, "responses"),
    {
      body: JSON.stringify(payload),
      clientSignal: options.clientSignal,
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
      decorateHeaders: async (headers) => {
        applyOpencodeSessionHeader(
          providerConfig,
          headers,
          payload.prompt_cache_key?.trim() || undefined,
        )
        await applyXaiGrokBuildHeaders(providerConfig, headers, payload)
      },
    },
  )
}

const PROVIDER_MODELS_TIMEOUT_MS = 15_000

export async function forwardProviderModels(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Promise<Response> {
  if (providerConfig.type === "google") {
    return await forwardGoogleModels(providerConfig, requestHeaders)
  }
  const pool = providerConfig.keyPool ?? []
  const attempts =
    pool.length > 1 ? Math.min(pool.length, MAX_PROVIDER_KEY_ATTEMPTS) : 1
  const seen = new Set<string>()
  let response: Response | null = null

  for (let attempt = 0; attempt < attempts; attempt++) {
    const { apiKey, key } = selectProviderRequestApiKey(providerConfig)
    if (seen.has(apiKey)) break
    seen.add(apiKey)

    response = await fetch(
      resolveProviderEndpointUrl(providerConfig, "models"),
      {
        method: "GET",
        headers: buildProviderUpstreamHeaders(
          providerConfig,
          requestHeaders,
          apiKey,
        ),
        signal: AbortSignal.timeout(PROVIDER_MODELS_TIMEOUT_MS),
      },
    )
    noteProviderApiKeyResult(providerConfig.name, key, response.status)
    if (response.status !== 429) break
  }

  if (!response) {
    throw new Error("Provider models request was not attempted")
  }
  return response
}

async function forwardGoogleModels(
  provider: ResolvedProviderConfig,
  requestHeaders: Headers,
): Promise<Response> {
  const data: Array<Record<string, unknown>> = []
  const pageTokens = new Set<string>()
  let pageToken: string | undefined
  const signal = AbortSignal.timeout(PROVIDER_MODELS_TIMEOUT_MS)
  const { apiKey, key } = selectProviderRequestApiKey(provider)
  do {
    const url = new URL(resolveProviderEndpointUrl(provider, "models"))
    url.searchParams.set("pageSize", "1000")
    if (pageToken) url.searchParams.set("pageToken", pageToken)
    const upstream = await fetch(url, {
      headers: buildProviderUpstreamHeaders(provider, requestHeaders, apiKey),
      signal,
    })
    if (!upstream.ok) {
      noteProviderApiKeyResult(provider.name, key, upstream.status)
      return upstream
    }
    const body = (await upstream.json()) as GoogleModelsResponse
    for (const model of body.models ?? []) {
      if (!model.supportedGenerationMethods?.includes("generateContent"))
        continue
      data.push({
        id: model.name.replace(/^models\//u, ""),
        object: "model",
        owned_by: provider.name,
        name: model.displayName,
        display_name: model.displayName,
        description: model.description,
        context_window: model.inputTokenLimit,
        max_output_tokens: model.outputTokenLimit,
      })
    }
    pageToken = body.nextPageToken
    if (pageToken && pageTokens.has(pageToken))
      throw new Error("Google models returned a repeated page token")
    if (pageToken) pageTokens.add(pageToken)
  } while (pageToken)
  return Response.json({ object: "list", data, has_more: false })
}

/** Align with Codex images: long-running generation/edits need a generous cap. */
const PROVIDER_IMAGES_TIMEOUT_MS = 15 * 60 * 1000

const providerImagesDispatcher = createTimeoutDispatcher(
  PROVIDER_IMAGES_TIMEOUT_MS,
)

function resolveProviderRequestUrl(
  providerConfig: ResolvedProviderConfig,
  requestUrl: string,
  path: string,
): string {
  const upstreamUrl = new URL(
    resolveProviderEndpointUrl(providerConfig, path.replace(/^\/v1\//u, "")),
  )
  upstreamUrl.search = new URL(requestUrl, "http://localhost").search
  return upstreamUrl.toString()
}

export async function forwardProviderAlphaSearch(
  providerConfig: ResolvedProviderConfig,
  request: Request,
  options: { clientSignal?: AbortSignal } = {},
): Promise<Response> {
  const body = await request.arrayBuffer()
  const transportConfig = getUpstreamTransportConfig()

  return await fetchProviderUpstream(
    providerConfig,
    request.headers,
    resolveProviderRequestUrl(providerConfig, request.url, "/v1/alpha/search"),
    {
      body,
      clientSignal: options.clientSignal,
      headersTimeoutMs: transportConfig.headersTimeoutMs,
      streamInactivityTimeoutMs: transportConfig.streamInactivityTimeoutMs,
    },
  )
}

export async function forwardProviderImages(
  providerConfig: ResolvedProviderConfig,
  request: Request,
  operation: "generations" | "edits",
): Promise<Response> {
  const { apiKey, key } = selectProviderRequestApiKey(providerConfig)
  const headers = buildProviderUpstreamHeaders(
    providerConfig,
    request.headers,
    apiKey,
  )
  const contentType = request.headers.get("content-type")
  if (contentType) {
    headers["content-type"] = contentType
  } else if (operation === "edits") {
    delete headers["content-type"]
  }

  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers,
    body: request.body,
    duplex: "half",
    signal: AbortSignal.any([
      request.signal,
      AbortSignal.timeout(PROVIDER_IMAGES_TIMEOUT_MS),
    ]),
  }

  const upstreamUrl = resolveProviderRequestUrl(
    providerConfig,
    request.url,
    `/v1/images/${operation}`,
  )

  // The request body is a stream, so a 429 cannot be replayed with another
  // key. Select once, then record the outcome so later requests avoid a key
  // that was rejected.
  const response =
    typeof Bun !== "undefined" ?
      await fetch(upstreamUrl, init)
      // Node's global fetch keeps Undici's shorter default headers/body
      // timeouts. Use an explicit dispatcher so the documented 15-minute cap
      // applies there.
    : ((await undiciFetch(upstreamUrl, {
        ...init,
        dispatcher: providerImagesDispatcher,
      } as unknown as UndiciRequestInit)) as unknown as Response)
  noteProviderApiKeyResult(providerConfig.name, key, response.status)
  return response
}
