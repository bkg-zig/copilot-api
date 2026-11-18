import { randomUUID } from "node:crypto"

import type { Model } from "~/lib/types/models"

import { WEB_USER_AGENT, webFetch } from "./http"
import {
  deltasToResponse,
  lastUserText,
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

const BASE = "https://chat.qwen.ai"
const LOGIN_HINT =
  "Sign in at chat.qwen.ai, open DevTools → Network, copy a request to /api/v2/chat/completions as fetch and paste it in the dashboard: Web API → Qwen (Web)."

const MODELS: Array<Model> = [
  webModel("qwen3-max", "Qwen3 Max (Web)", "alibaba"),
  webModel("qwen3-plus", "Qwen3 Plus (Web)", "alibaba"),
  webModel("qwen3-turbo", "Qwen3 Turbo (Web)", "alibaba"),
]

function headers(input: WebSessionInput, extra: Record<string, string> = {}) {
  const out: Record<string, string> = {
    accept: "*/*",
    "content-type": "application/json",
    origin: BASE,
    referer: `${BASE}/`,
    "user-agent": WEB_USER_AGENT,
    ...extra,
  }
  if (input.kind === "cookie" && input.value) out.cookie = input.value
  if (input.kind === "token" && input.value) {
    out.authorization = `Bearer ${input.value}`
  }
  if (!out.cookie && !out.authorization) {
    throw new WebSessionError(401, "qwen_login_required", LOGIN_HINT)
  }
  return out
}

async function createChat(
  input: WebSessionInput,
  model: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const response = await webFetch(
    `${BASE}/api/v2/chats/new`,
    {
      method: "POST",
      headers: headers(input),
      body: JSON.stringify({
        title: "Gateway Chat",
        models: [model],
        chat_mode: "normal",
        chat_type: "t2t",
        timestamp: Date.now(),
        project_id: "",
      }),
    },
    { ...options, label: "qwen-web", loginHint: LOGIN_HINT },
  )
  const data = (await response.json()) as { data?: { id?: string } }
  if (!data.data?.id) {
    throw new WebSessionError(
      502,
      "qwen_session_create_failed",
      LOGIN_HINT,
      "Qwen did not return a chat id.",
    )
  }
  return data.data.id
}

async function* qwenDeltas(
  input: WebSessionInput,
  model: string,
  prompt: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): AsyncGenerator<WebDelta> {
  const chatId = await createChat(input, model, options)
  const ts = Math.floor(Date.now() / 1000)
  const payload = {
    stream: true,
    version: "2.1",
    incremental_output: true,
    chatId,
    parentId: "",
    chat_id: chatId,
    chat_mode: "normal",
    model,
    parent_id: null,
    messages: [
      {
        id: null,
        fid: randomUUID(),
        parentId: null,
        childrenIds: [randomUUID()],
        role: "user",
        content: prompt,
        user_action: "chat",
        files: [],
        timestamp: ts,
        models: [model],
        model: "",
        chat_type: "t2t",
        feature_config: {
          thinking_enabled: false,
          output_schema: "phase",
          research_mode: "normal",
          auto_thinking: false,
          thinking_mode: "off",
          auto_search: false,
        },
        extra: { meta: { subChatType: "t2t" } },
        sub_chat_type: "t2t",
        parent_id: null,
      },
    ],
    timestamp: ts + 1,
  }
  const response = await webFetch(
    `${BASE}/api/v2/chat/completions?chat_id=${chatId}`,
    {
      method: "POST",
      headers: headers(input, {
        accept: "text/event-stream",
        referer: `${BASE}/c/${chatId}`,
        "x-accel-buffering": "no",
      }),
      body: JSON.stringify(payload),
    },
    { ...options, label: "qwen-web", loginHint: LOGIN_HINT },
  )
  if (!response.body) return
  for await (const data of parseSSEData(response.body, options.signal)) {
    if (data === "[DONE]") break
    const event = parseJSONLine<{
      choices?: Array<{
        delta?: { phase?: string; content?: string; status?: string }
        finish_reason?: string | null
      }>
    }>(data)
    const choice = event?.choices?.[0]
    if (!choice) continue
    if (choice.delta?.content) {
      if (choice.delta.phase === "thinking") {
        yield { reasoning: choice.delta.content }
      } else {
        yield { content: choice.delta.content }
      }
    }
    if (choice.finish_reason) yield { finishReason: choice.finish_reason }
  }
}

export const qwenWebAdapter: WebProviderAdapter = {
  id: "qwen-web",
  displayName: "Qwen (Web)",
  webUrl: BASE,
  loginHint: LOGIN_HINT,
  sessionKinds: ["cookie", "token", "fetch-capture"],
  async validateSession(input, options) {
    // Creating a chat is the cheapest authenticated probe Qwen exposes.
    await createChat(input, MODELS[0].id, options)
    return { accountLabel: "Qwen Web", modelCount: MODELS.length }
  },
  listModels() {
    return Promise.resolve(MODELS)
  },
  async chatCompletion(providerConfig, payload, options) {
    const input = sessionInputFromConfig(providerConfig)
    const model = stripAdapterPrefix(payload.model, "qwen-web")
    const slug = MODELS.some((m) => m.id === model) ? model : MODELS[0].id
    return deltasToResponse(
      qwenDeltas(input, slug, lastUserText(payload.messages), {
        fetchFn: options?.fetchFn,
        signal: options?.signal ?? options?.clientSignal,
      }),
      payload,
    )
  },
}
