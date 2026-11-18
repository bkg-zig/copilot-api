import { randomUUID } from "node:crypto"

import type { Model } from "~/lib/types/models"

import { WEB_USER_AGENT, webFetch } from "./http"
import {
  deltasToResponse,
  parseJSONLine,
  parseSSEData,
  type WebDelta,
} from "./stream"
import { stripAdapterPrefix, webModel, type WebProviderAdapter } from "./types"

const ORIGIN = "https://chat.inceptionlabs.ai"
const LOGIN_HINT =
  "Inception (Mercury) needs no account: the gateway mints a session token itself. Just enable the provider."

const MODELS: Array<Model> = [
  webModel("mercury", "Mercury (Web)", "inception"),
  webModel("mercury-low", "Mercury Low (Web)", "inception"),
  webModel("mercury-high", "Mercury High (Web)", "inception"),
]

let cachedToken: { token: string; at: number } | null = null
const TOKEN_MAX_AGE_MS = 10 * 60 * 1000

async function mintToken(
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.at < TOKEN_MAX_AGE_MS) {
    return cachedToken.token
  }
  const response = await webFetch(
    `${ORIGIN}/api/session`,
    {
      headers: {
        accept: "*/*",
        origin: ORIGIN,
        referer: `${ORIGIN}/`,
        "user-agent": WEB_USER_AGENT,
      },
    },
    { ...options, label: "inception-web", loginHint: LOGIN_HINT },
  )
  const data = (await response.json()) as { token?: string }
  if (!data.token) throw new Error("Inception /api/session returned no token.")
  cachedToken = { token: data.token, at: Date.now() }
  return data.token
}

async function* inceptionDeltas(
  model: string,
  messages: Array<{ role: string; content: string }>,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): AsyncGenerator<WebDelta> {
  const token = await mintToken(options)
  const effort =
    model.endsWith("-high") ? "high"
    : model.endsWith("-low") ? "low"
    : "medium"
  const body = {
    reasoningEffort: effort,
    webSearchEnabled: false,
    voiceMode: false,
    timezone: "UTC",
    language: "en-US",
    id: randomUUID(),
    messages: messages.map((message) => ({
      id: randomUUID(),
      role: message.role === "assistant" ? "assistant" : "user",
      parts: [{ type: "text", text: message.content, state: "done" }],
    })),
    trigger: "submit-message",
  }
  const response = await webFetch(
    `${ORIGIN}/api/chat`,
    {
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        origin: ORIGIN,
        referer: `${ORIGIN}/`,
        "user-agent": WEB_USER_AGENT,
        "x-session-token": token,
      },
      body: JSON.stringify(body),
    },
    { ...options, label: "inception-web", loginHint: LOGIN_HINT },
  )
  if (!response.body) return
  for await (const data of parseSSEData(response.body, options.signal)) {
    if (data === "[DONE]") break
    const event = parseJSONLine<{ type?: string; delta?: string }>(data)
    if (!event) continue
    if (event.type === "text-delta" && event.delta)
      yield { content: event.delta }
    if (event.type === "reasoning-delta" && event.delta) {
      yield { reasoning: event.delta }
    }
  }
  yield { finishReason: "stop" }
}

export const inceptionWebAdapter: WebProviderAdapter = {
  id: "inception-web",
  displayName: "Inception Mercury (Web)",
  webUrl: ORIGIN,
  loginHint: LOGIN_HINT,
  sessionKinds: ["none"],
  async validateSession(_input, options) {
    await mintToken(options)
    return { accountLabel: "Inception (authless)", modelCount: MODELS.length }
  },
  listModels() {
    return Promise.resolve(MODELS)
  },
  async chatCompletion(_providerConfig, payload, options) {
    const model = stripAdapterPrefix(payload.model, "inception-web")
    const slug = MODELS.some((m) => m.id === model) ? model : "mercury"
    const messages = payload.messages.map((message) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content : "",
    }))
    return deltasToResponse(
      inceptionDeltas(slug, messages, {
        fetchFn: options?.fetchFn,
        signal: options?.signal ?? options?.clientSignal,
      }),
      payload,
    )
  },
}
