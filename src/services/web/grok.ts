import type { Model } from "~/lib/types/models"

import { cookieHeaderOf, WEB_USER_AGENT, webFetch } from "./http"
import {
  deltasToResponse,
  lastUserText,
  parseJSONLine,
  type WebDelta,
} from "./stream"
import {
  sessionInputFromConfig,
  stripAdapterPrefix,
  webModel,
  WebSessionError,
  type WebProviderAdapter,
  type WebSessionInput,
} from "./types"

const BASE = "https://grok.com"
const LOGIN_HINT =
  "Sign in at grok.com, then paste the sso cookie (DevTools → Application → Cookies) in the dashboard: Web API → Grok (Web)."

const MODELS: Array<Model> = [
  webModel("grok-4", "Grok 4 (Web)", "xai"),
  webModel("grok-4-fast", "Grok 4 Fast (Web)", "xai"),
  webModel("grok-3", "Grok 3 (Web)", "xai"),
]

function headers(input: WebSessionInput, extra: Record<string, string> = {}) {
  let cookie = cookieHeaderOf(input)
  if (!cookie && input.value) {
    cookie = input.value.includes("=") ? input.value : `sso=${input.value}`
  }
  if (!cookie) {
    throw new WebSessionError(401, "grok_login_required", LOGIN_HINT)
  }
  return {
    accept: "*/*",
    "content-type": "application/json",
    cookie,
    origin: BASE,
    referer: `${BASE}/`,
    "user-agent": WEB_USER_AGENT,
    ...extra,
  }
}

function findToken(value: unknown): string {
  if (typeof value !== "object" || value === null) return ""
  const record = value as Record<string, unknown>
  if (typeof record.token === "string" && record.token) return record.token
  if (typeof record.message === "string" && record.isSoftStop !== true) {
    // Only the nested response message is a text delta; handled by caller shape.
  }
  for (const item of Object.values(record)) {
    const found = findToken(item)
    if (found) return found
  }
  return ""
}

async function* grokDeltas(
  input: WebSessionInput,
  model: string,
  prompt: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): AsyncGenerator<WebDelta> {
  const response = await webFetch(
    `${BASE}/rest/app-chat/conversations/new`,
    {
      method: "POST",
      headers: headers(input, { accept: "text/event-stream" }),
      body: JSON.stringify({
        temporary: true,
        modelName: model,
        message: prompt,
        disableMemory: true,
        enableImageGeneration: false,
        returnImageBytes: false,
        enableImageStreaming: false,
        forceConcise: false,
        isReasoning: false,
        sendFinalMetadata: true,
        disableTextFollowUps: true,
      }),
    },
    { ...options, label: "grok-web", loginHint: LOGIN_HINT },
  )
  if (!response.body) return
  const reader =
    response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === "[DONE]") continue
        const event = parseJSONLine<Record<string, unknown>>(
          trimmed.replace(/^data:\s*/, ""),
        )
        if (!event) continue
        const result = event.result as Record<string, unknown> | undefined
        const inner = result?.response as Record<string, unknown> | undefined
        const token =
          typeof inner?.token === "string" ? inner.token : findToken(event)
        if (token) yield { content: token }
        if (inner?.isSoftStop === true || result?.isFinal === true) {
          yield { finishReason: "stop" }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export const grokWebAdapter: WebProviderAdapter = {
  id: "grok-web",
  displayName: "Grok (Web)",
  webUrl: BASE,
  loginHint: LOGIN_HINT,
  sessionKinds: ["cookie", "token", "fetch-capture"],
  async validateSession(input, options) {
    const response = await webFetch(
      `${BASE}/rest/rate-limits`,
      {
        method: "POST",
        headers: headers(input),
        body: JSON.stringify({ modelName: MODELS[0].id }),
      },
      { ...options, label: "grok-web", loginHint: LOGIN_HINT },
    )
    await response.text().catch(() => "")
    return { accountLabel: "Grok Web", modelCount: MODELS.length }
  },
  listModels() {
    return Promise.resolve(MODELS)
  },
  async chatCompletion(providerConfig, payload, options) {
    const input = sessionInputFromConfig(providerConfig)
    const model = stripAdapterPrefix(payload.model, "grok-web")
    const slug = MODELS.some((m) => m.id === model) ? model : MODELS[0].id
    return deltasToResponse(
      grokDeltas(input, slug, lastUserText(payload.messages), {
        fetchFn: options?.fetchFn,
        signal: options?.signal ?? options?.clientSignal,
      }),
      payload,
    )
  },
}
