import type { Model } from "~/lib/types/models"

import { cookieHeaderOf, WEB_USER_AGENT, webFetch } from "./http"
import { deltasToResponse, lastUserText, type WebDelta } from "./stream"
import {
  sessionInputFromConfig,
  stripAdapterPrefix,
  webModel,
  WebSessionError,
  type WebProviderAdapter,
  type WebSessionInput,
} from "./types"

const BASE = "https://gemini.google.com"
const GENERATE_URL = `${BASE}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
const LOGIN_HINT =
  "Sign in at gemini.google.com, then paste the cookies __Secure-1PSID and __Secure-1PSIDTS (DevTools → Application → Cookies) in the dashboard: Web API → Gemini (Web)."

const MODELS: Array<Model> = [
  webModel("gemini-2.5-flash", "Gemini 2.5 Flash (Web)", "google"),
  webModel("gemini-2.5-pro", "Gemini 2.5 Pro (Web)", "google"),
  webModel("gemini-2.0-flash", "Gemini 2.0 Flash (Web)", "google"),
]

function headers(input: WebSessionInput, extra: Record<string, string> = {}) {
  const cookie = cookieHeaderOf(input) ?? input.value
  if (!cookie || !cookie.includes("__Secure-1PSID")) {
    throw new WebSessionError(401, "gemini_login_required", LOGIN_HINT)
  }
  return {
    accept: "*/*",
    cookie,
    origin: BASE,
    referer: `${BASE}/app`,
    "user-agent": WEB_USER_AGENT,
    ...extra,
  }
}

async function sessionToken(
  input: WebSessionInput,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const response = await webFetch(
    `${BASE}/app`,
    { headers: headers(input) },
    { ...options, label: "gemini-web", loginHint: LOGIN_HINT },
  )
  const html = await response.text()
  const match = /"SNlM0e":"([^"]+)"/.exec(html)
  return match?.[1] ?? ""
}

function extractCanonicalText(payload: unknown): string {
  if (!Array.isArray(payload) || payload.length <= 4) return ""
  const candidates: unknown = payload[4]
  if (!Array.isArray(candidates) || candidates.length === 0) return ""
  const first: unknown = candidates[0]
  if (!Array.isArray(first) || first.length <= 1) return ""
  const body: unknown = first[1]
  if (Array.isArray(body) && body.length > 0) {
    const direct: unknown = body[0]
    if (typeof direct === "string") return direct
    if (Array.isArray(direct) && typeof direct[0] === "string") return direct[0]
  }
  return ""
}

function parseGenerateChunk(text: string): Array<unknown> {
  const out: Array<unknown> = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("[")) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) out.push(...(parsed as Array<unknown>))
    } catch {
      // Partial frame; ignore.
    }
  }
  return out
}

async function* geminiDeltas(
  input: WebSessionInput,
  prompt: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): AsyncGenerator<WebDelta> {
  const at = await sessionToken(input, options)
  const inner = JSON.stringify([[prompt], null, null, null])
  const form = new URLSearchParams({
    "f.req": JSON.stringify([null, inner]),
    ...(at ? { at } : {}),
  })
  const response = await webFetch(
    at ? `${GENERATE_URL}?at=${encodeURIComponent(at)}` : GENERATE_URL,
    {
      method: "POST",
      headers: headers(input, {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      }),
      body: form.toString(),
    },
    { ...options, label: "gemini-web", loginHint: LOGIN_HINT },
  )
  const raw = (await response.text()).replace(/^\)\]\}'\s*/, "")
  let full = ""
  for (const entry of parseGenerateChunk(raw)) {
    if (
      !Array.isArray(entry)
      || entry[1] !== "assistant.lamda.BardFrontendService.StreamGenerate"
    ) {
      continue
    }
    let innerPayload: unknown = entry[2]
    if (typeof innerPayload === "string") {
      try {
        innerPayload = JSON.parse(innerPayload)
      } catch {
        continue
      }
    }
    const text = extractCanonicalText(innerPayload)
    if (text && text.length > full.length) {
      yield { content: text.slice(full.length) }
      full = text
    }
  }
  yield { finishReason: "stop" }
}

export const geminiWebAdapter: WebProviderAdapter = {
  id: "gemini-web",
  displayName: "Gemini (Web)",
  webUrl: BASE,
  loginHint: LOGIN_HINT,
  sessionKinds: ["cookie", "fetch-capture"],
  async validateSession(input, options) {
    await sessionToken(input, options)
    return { accountLabel: "Gemini Web", modelCount: MODELS.length }
  },
  listModels() {
    return Promise.resolve(MODELS)
  },
  async chatCompletion(providerConfig, payload, options) {
    const input = sessionInputFromConfig(providerConfig)
    void stripAdapterPrefix(payload.model, "gemini-web")
    return deltasToResponse(
      geminiDeltas(input, lastUserText(payload.messages), {
        fetchFn: options?.fetchFn,
        signal: options?.signal ?? options?.clientSignal,
      }),
      payload,
    )
  },
}
