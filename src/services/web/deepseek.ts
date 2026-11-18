import { createHash } from "node:crypto"

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

const BASE = "https://chat.deepseek.com/api/v0"
const LOGIN_HINT =
  "Sign in at chat.deepseek.com, open DevTools → Network, copy a request to /api/v0/chat/completion as fetch and paste it in the dashboard: Web API → DeepSeek (Web). Note: DeepSeek bans aggressive API use; the gateway rate-limits this account."

const MODELS: Array<Model> = [
  webModel("deepseek-chat", "DeepSeek Chat (Web)", "deepseek"),
  webModel("deepseek-reasoner", "DeepSeek Reasoner (Web)", "deepseek"),
]

export interface DeepSeekPowChallenge {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
  target_path: string
}

/**
 * DeepSeekHashV1 solver: find a nonce whose sha3-512 hash of
 * `${salt}_${expire_at}_${nonce}` carries the challenge prefix. Pure
 * TypeScript (no WASM asset), bounded so a pathological difficulty cannot
 * block the gateway.
 */
export function solveDeepSeekPow(
  challenge: DeepSeekPowChallenge,
  maxAttempts = 5_000_000,
): number | null {
  if (challenge.algorithm !== "DeepSeekHashV1") {
    throw new Error(
      `Unsupported DeepSeek POW algorithm: ${challenge.algorithm}`,
    )
  }
  const prefix = `${challenge.salt}_${challenge.expire_at}_`
  const wanted = Math.max(
    1,
    Math.min(
      challenge.challenge.length,
      Math.ceil(challenge.difficulty / 16) || 4,
    ),
  )
  const target = challenge.challenge.slice(0, wanted)
  for (let nonce = 0; nonce < maxAttempts; nonce++) {
    const hex = createHash("sha3-512").update(`${prefix}${nonce}`).digest("hex")
    if (hex.startsWith(target)) return nonce
  }
  return null
}

export function encodeDeepSeekPow(
  challenge: DeepSeekPowChallenge,
  answer: number,
): string {
  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    }),
  ).toString("base64")
}

function headers(input: WebSessionInput, extra: Record<string, string> = {}) {
  const out: Record<string, string> = {
    accept: "*/*",
    "content-type": "application/json",
    origin: "https://chat.deepseek.com",
    referer: "https://chat.deepseek.com/",
    "user-agent": WEB_USER_AGENT,
    ...extra,
  }
  if (input.kind === "cookie" && input.value) out.cookie = input.value
  if (input.kind === "token" && input.value) {
    out.authorization = `Bearer ${input.value}`
  }
  if (!out.cookie && !out.authorization) {
    throw new WebSessionError(401, "deepseek_login_required", LOGIN_HINT)
  }
  return out
}

async function powHeader(
  input: WebSessionInput,
  targetPath: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const response = await webFetch(
    `${BASE}/chat/create_pow_challenge`,
    {
      method: "POST",
      headers: headers(input),
      body: JSON.stringify({ target_path: targetPath }),
    },
    { ...options, label: "deepseek-web", loginHint: LOGIN_HINT },
  )
  const data = (await response.json()) as {
    data?: { biz_data?: { challenge?: DeepSeekPowChallenge } }
  }
  const challenge = data.data?.biz_data?.challenge
  if (!challenge) {
    throw new WebSessionError(
      502,
      "deepseek_pow_missing",
      LOGIN_HINT,
      "DeepSeek did not return a POW challenge.",
    )
  }
  const answer = solveDeepSeekPow(challenge)
  if (answer === null) {
    throw new WebSessionError(
      502,
      "deepseek_pow_unsolved",
      LOGIN_HINT,
      "DeepSeek POW challenge could not be solved in the attempt budget.",
    )
  }
  return encodeDeepSeekPow(challenge, answer)
}

async function createSession(
  input: WebSessionInput,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const response = await webFetch(
    `${BASE}/chat_session/create`,
    {
      method: "POST",
      headers: headers(input),
      body: JSON.stringify({ character_id: null }),
    },
    { ...options, label: "deepseek-web", loginHint: LOGIN_HINT },
  )
  const data = (await response.json()) as {
    data?: {
      biz_data?: { id?: string; chat_session?: { id?: string } }
      biz_code?: number
    }
  }
  const id = data.data?.biz_data?.id ?? data.data?.biz_data?.chat_session?.id
  if (!id) {
    throw new WebSessionError(
      502,
      "deepseek_session_create_failed",
      LOGIN_HINT,
      "DeepSeek did not return a chat session id.",
    )
  }
  return id
}

async function* deepseekDeltas(
  input: WebSessionInput,
  model: string,
  prompt: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): AsyncGenerator<WebDelta> {
  const sessionId = await createSession(input, options)
  const pow = await powHeader(input, "/api/v0/chat/completion", options)
  const response = await webFetch(
    `${BASE}/chat/completion`,
    {
      method: "POST",
      headers: headers(input, {
        accept: "text/event-stream",
        "x-ds-pow-response": pow,
      }),
      body: JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: null,
        model_type: model === "deepseek-reasoner" ? "reasoner" : null,
        prompt,
        ref_file_ids: [],
        thinking_enabled: model === "deepseek-reasoner",
        search_enabled: false,
        action: null,
        preempt: false,
      }),
    },
    { ...options, label: "deepseek-web", loginHint: LOGIN_HINT },
  )
  if (!response.body) return
  let currentType = "RESPONSE"
  for await (const data of parseSSEData(response.body, options.signal)) {
    if (data === "[DONE]") break
    const event = parseJSONLine<{
      v?: unknown
      p?: string
      o?: string
    }>(data)
    if (!event) continue
    // Snapshot: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"..."}]}}}
    const snapshot = event.v as
      | {
          response?: { fragments?: Array<{ type?: string; content?: string }> }
        }
      | string
      | undefined
    if (typeof snapshot === "object" && snapshot?.response?.fragments) {
      for (const fragment of snapshot.response.fragments) {
        if (!fragment.content) continue
        currentType = fragment.type ?? currentType
        yield fragment.type === "THINK" ?
          { reasoning: fragment.content }
        : { content: fragment.content }
      }
      continue
    }
    if (typeof event.v === "string" && event.v) {
      yield currentType === "THINK" ?
        { reasoning: event.v }
      : { content: event.v }
    }
    if (Array.isArray(event.v)) {
      for (const fragment of event.v as Array<{
        type?: string
        content?: string
      }>) {
        if (!fragment.content) continue
        currentType = fragment.type ?? currentType
        yield fragment.type === "THINK" ?
          { reasoning: fragment.content }
        : { content: fragment.content }
      }
    }
  }
  yield { finishReason: "stop" }
}

export const deepseekWebAdapter: WebProviderAdapter = {
  id: "deepseek-web",
  displayName: "DeepSeek (Web)",
  webUrl: "https://chat.deepseek.com",
  loginHint: LOGIN_HINT,
  sessionKinds: ["cookie", "token", "fetch-capture"],
  async validateSession(input, options) {
    await createSession(input, options)
    return { accountLabel: "DeepSeek Web", modelCount: MODELS.length }
  },
  listModels() {
    return Promise.resolve(MODELS)
  },
  async chatCompletion(providerConfig, payload, options) {
    const input = sessionInputFromConfig(providerConfig)
    const model = stripAdapterPrefix(payload.model, "deepseek-web")
    const slug = MODELS.some((m) => m.id === model) ? model : MODELS[0].id
    return deltasToResponse(
      deepseekDeltas(input, slug, lastUserText(payload.messages), {
        fetchFn: options?.fetchFn,
        signal: options?.signal ?? options?.clientSignal,
      }),
      payload,
    )
  },
}
