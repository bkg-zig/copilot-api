import { randomUUID } from "node:crypto"

import type { Model } from "~/lib/types/models"

import { cookieHeaderOf, WEB_USER_AGENT, webFetch } from "./http"
import { acquireWebSlot } from "./rate-limit"
import {
  deltasToResponse,
  messagesToPrompt,
  parseJSONLine,
  parseSSEData,
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

const BASE = "https://claude.ai/api"
const LOGIN_HINT =
  "Sign in at claude.ai, open DevTools → Network, copy a request to claude.ai as fetch (it must include the cookie header) and paste it in the dashboard: Web API → Claude (Web)."

const MODELS: Array<Model> = [
  webModel("claude-sonnet-4-6", "Claude Sonnet 4.6 (Web)", "anthropic"),
  webModel("claude-opus-4-6", "Claude Opus 4.6 (Web)", "anthropic"),
  webModel("claude-haiku-4-5-20251001", "Claude Haiku 4.5 (Web)", "anthropic"),
]

function headers(input: WebSessionInput, extra: Record<string, string> = {}) {
  const cookie = cookieHeaderOf(input) ?? input.value
  if (!cookie) {
    throw new WebSessionError(401, "claude_login_required", LOGIN_HINT)
  }
  return {
    accept: "*/*",
    "content-type": "application/json",
    cookie,
    origin: "https://claude.ai",
    referer: "https://claude.ai/chat",
    "user-agent": WEB_USER_AGENT,
    ...extra,
  }
}

function orgFromCookie(cookie: string): string | null {
  const match = /(?:^|;\s*)lastActiveOrg=([a-f0-9-]{36})/i.exec(cookie)
  return match?.[1] ?? null
}

async function resolveOrgId(
  input: WebSessionInput,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const cookie = cookieHeaderOf(input) ?? input.value ?? ""
  const fromCookie = orgFromCookie(cookie)
  if (fromCookie) return fromCookie
  const response = await webFetch(
    `${BASE}/organizations`,
    { headers: headers(input) },
    { ...options, label: "claude-web", loginHint: LOGIN_HINT },
  )
  const data: unknown = await response.json()
  const first: unknown = Array.isArray(data) ? data[0] : data
  const uuid =
    typeof first === "object" && first !== null && "uuid" in first ?
      String((first as { uuid: unknown }).uuid)
    : null
  if (!uuid) {
    throw new WebSessionError(
      502,
      "claude_org_not_found",
      LOGIN_HINT,
      "Claude did not return an organization for this session.",
    )
  }
  return uuid
}

async function* claudeDeltas(
  input: WebSessionInput,
  model: string,
  prompt: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): AsyncGenerator<WebDelta> {
  const orgId = await resolveOrgId(input, options)
  const conversationId = randomUUID()
  const body = {
    prompt,
    timezone: "UTC",
    locale: "en-US",
    model,
    tools: [],
    turn_message_uuids: {
      human_message_uuid: randomUUID(),
      assistant_message_uuid: randomUUID(),
    },
    attachments: [],
    files: [],
    sync_sources: [],
    completion_request_id: randomUUID(),
    rendering_mode: "messages",
    thinking_mode: "off",
    create_conversation_params: {
      name: "",
      model,
      include_conversation_preferences: true,
      paprika_mode: null,
      compass_mode: null,
      tool_search_mode: "off",
      is_temporary: false,
      enabled_imagine: false,
    },
  }
  await acquireWebSlot("claude-web", options.signal)
  const response = await webFetch(
    `${BASE}/organizations/${orgId}/chat_conversations/${conversationId}/completion`,
    {
      method: "POST",
      headers: headers(input, { accept: "text/event-stream" }),
      body: JSON.stringify(body),
    },
    { ...options, label: "claude-web", loginHint: LOGIN_HINT },
  )
  if (!response.body) return
  for await (const data of parseSSEData(response.body, options.signal)) {
    if (data === "[DONE]") break
    const event = parseJSONLine<{
      type?: string
      delta?: { type?: string; text?: string; thinking?: string }
      error?: { message?: string }
    }>(data)
    if (!event) continue
    if (event.type === "error") {
      throw new WebSessionError(
        502,
        "claude_stream_error",
        LOGIN_HINT,
        event.error?.message ?? "Claude stream error.",
      )
    }
    if (event.type === "content_block_delta") {
      if (event.delta?.type === "text_delta" && event.delta.text) {
        yield { content: event.delta.text }
      } else if (
        event.delta?.type === "thinking_delta"
        && event.delta.thinking
      ) {
        yield { reasoning: event.delta.thinking }
      }
    }
    if (event.type === "message_stop") yield { finishReason: "stop" }
  }
}

export const claudeWebAdapter: WebProviderAdapter = {
  id: "claude-web",
  displayName: "Claude (Web)",
  webUrl: "https://claude.ai",
  loginHint: LOGIN_HINT,
  sessionKinds: ["cookie", "fetch-capture"],
  async validateSession(input, options) {
    const response = await webFetch(
      `${BASE}/account_profile`,
      { headers: headers(input) },
      { ...options, label: "claude-web", loginHint: LOGIN_HINT },
    )
    const profile: unknown = await response.json().catch(() => null)
    const label =
      typeof profile === "object" && profile !== null ?
        ((profile as { display_name?: string; full_name?: string }).display_name
        ?? (profile as { full_name?: string }).full_name
        ?? "Claude Web")
      : "Claude Web"
    return { accountLabel: String(label), modelCount: MODELS.length }
  },
  listModels() {
    return Promise.resolve(MODELS)
  },
  async chatCompletion(providerConfig, payload, options) {
    const input = sessionInputFromConfig(providerConfig)
    const model = stripAdapterPrefix(payload.model, "claude-web")
    const slug = MODELS.some((m) => m.id === model) ? model : MODELS[0].id
    const prompt = `${messagesToPrompt(payload.messages)}\n\nAssistant:`
    return deltasToResponse(
      claudeDeltas(input, slug, prompt, {
        fetchFn: options?.fetchFn,
        signal: options?.signal ?? options?.clientSignal,
      }),
      payload,
    )
  },
}
