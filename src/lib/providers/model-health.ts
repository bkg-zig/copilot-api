import { createHandlerLogger } from "~/lib/logger"
import type { ResolvedProviderConfig } from "~/lib/types/config"
import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type { GoogleGenerateContentPayload } from "~/lib/types/google"
import type { ResponsesPayload } from "~/lib/types/responses"
import {
  forwardProviderChatCompletions,
  forwardProviderMessages,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"
import { forwardGoogleGenerateContent } from "~/services/providers/google"

const logger = createHandlerLogger("provider-model-health")
const HEALTHY_TTL_MS = 10 * 60 * 1000
const UNHEALTHY_TTL_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 60_000
const MAX_CONCURRENT_CHECKS = 8
const INITIAL_HEALTH_WAIT_MS = 12_000
const PROBE_PROMPT = "Reply with exactly OK and nothing else. Do not explain."

export interface ModelHealthEntry {
  healthy: boolean
  checkedAt: number
  reason?: string
}

type ModelRecord = Record<string, unknown>

const healthCache = new Map<string, ModelHealthEntry>()
const refreshes = new Map<string, Promise<void>>()

function providerCacheKey(provider: ResolvedProviderConfig): string {
  return provider.name + ":" + provider.baseUrl
}

function modelCacheKey(
  provider: ResolvedProviderConfig,
  modelId: string,
): string {
  return providerCacheKey(provider) + ":" + modelId
}

function readModelId(model: unknown): string | undefined {
  if (!model || typeof model !== "object" || Array.isArray(model))
    return undefined
  const id = (model as ModelRecord).id
  return typeof id === "string" && id.trim() ? id.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function nonEmptyText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0
  if (!Array.isArray(value)) return false
  return value.some(
    (part) =>
      isRecord(part)
      && typeof part.text === "string"
      && part.text.trim().length > 0,
  )
}

function extractCompletionText(body: unknown, providerType: string): boolean {
  if (!isRecord(body)) return false

  if (providerType === "anthropic") {
    return nonEmptyText(body.content)
  }

  if (providerType === "openai-responses") {
    if (typeof body.output_text === "string" && body.output_text.trim())
      return true
    if (!Array.isArray(body.output)) return false
    return body.output.some((item) => {
      if (!isRecord(item) || !Array.isArray(item.content)) return false
      return item.content.some(
        (part) =>
          isRecord(part)
          && (part.type === "output_text" || part.type === "text")
          && typeof part.text === "string"
          && part.text.trim().length > 0,
      )
    })
  }

  if (providerType === "google") {
    if (!Array.isArray(body.candidates)) return false
    return body.candidates.some((candidate) => {
      if (
        !isRecord(candidate)
        || !isRecord(candidate.content)
        || !Array.isArray(candidate.content.parts)
      )
        return false
      return candidate.content.parts.some(
        (part) =>
          isRecord(part)
          && part.thought !== true
          && typeof part.text === "string"
          && part.text.trim().length > 0,
      )
    })
  }

  if (!Array.isArray(body.choices)) return false
  return body.choices.some((choice) => {
    if (!isRecord(choice)) return false
    if (
      choice.finish_reason === "length"
      || choice.finish_reason === "max_tokens"
    )
      return false
    if (typeof choice.text === "string" && choice.text.trim()) return true
    return isRecord(choice.message) && nonEmptyText(choice.message.content)
  })
}

async function readJsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) return null
  return await response.json().catch(() => null)
}

async function readStreamingCompletionText(
  response: Response,
): Promise<boolean> {
  if (!response.body) return false
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let hasText = false
  let complete = false
  try {
    while (true) {
      const { done, value } = (await reader.read()) as {
        done: boolean
        value?: Uint8Array
      }
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (data === "[DONE]") {
          complete = true
          return hasText
        }
        if (!data) continue
        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch {
          continue
        }
        if (!isRecord(payload) || !Array.isArray(payload.choices)) continue
        for (const choice of payload.choices) {
          if (!isRecord(choice)) continue
          if (
            choice.finish_reason === "length"
            || choice.finish_reason === "max_tokens"
          ) {
            return false
          }
          const delta = isRecord(choice.delta) ? choice.delta : undefined
          const content = delta?.content ?? choice.text
          if (nonEmptyText(content)) hasText = true
          if (choice.finish_reason === "stop") {
            complete = true
            return hasText
          }
        }
      }
    }
    return hasText && complete
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined)
    else await reader.cancel().catch(() => undefined)
  }
}

async function sendProbe(
  provider: ResolvedProviderConfig,
  modelId: string,
  signal: AbortSignal,
): Promise<Response> {
  const headers = new Headers({
    "user-agent": "bkg-model-health-check/1.0",
    accept: "application/json",
  })

  if (provider.type === "anthropic") {
    const payload: AnthropicMessagesPayload = {
      model: modelId,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      max_tokens: 256,
      stream: false,
    }
    return await forwardProviderMessages(provider, payload, headers, {
      upstreamSignal: signal,
    })
  }

  if (provider.type === "openai-responses") {
    const payload: ResponsesPayload = {
      model: modelId,
      input: PROBE_PROMPT,
      max_output_tokens: 256,
      stream: false,
      store: false,
    }
    return await forwardProviderResponses(provider, payload, headers, {
      upstreamSignal: signal,
    })
  }

  if (provider.type === "google") {
    const payload: GoogleGenerateContentPayload = {
      contents: [{ role: "user", parts: [{ text: PROBE_PROMPT }] }],
      generationConfig: {
        candidateCount: 1,
        maxOutputTokens: 256,
        temperature: 0,
      },
    }
    return await forwardGoogleGenerateContent(
      provider,
      modelId,
      payload,
      headers,
      { stream: false, upstreamSignal: signal },
    )
  }

  const payload: ChatCompletionsPayload = {
    model: modelId,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    max_tokens: 256,
    temperature: 0,
    stream: false,
  }
  return await forwardProviderChatCompletions(provider, payload, headers, {
    upstreamSignal: signal,
  })
}

async function probeModel(
  provider: ResolvedProviderConfig,
  modelId: string,
): Promise<ModelHealthEntry> {
  const startedAt = Date.now()
  let reason = "empty_completion"
  try {
    const response = await sendProbe(
      provider,
      modelId,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    )
    if (!response.ok) {
      reason = "http_" + response.status
    } else {
      const isEventStream =
        response.headers
          .get("content-type")
          ?.toLowerCase()
          .includes("text/event-stream") === true
      const hasCompletionText =
        isEventStream && provider.type === "openai-compatible" ?
          await readStreamingCompletionText(response)
        : extractCompletionText(await readJsonResponse(response), provider.type)
      if (hasCompletionText) {
        return { healthy: true, checkedAt: Date.now() }
      }
      reason = "empty_or_invalid_completion"
    }
  } catch (error) {
    reason = error instanceof Error ? error.name : "request_failed"
  }

  logger.warn("model.health.failed", {
    provider: provider.name,
    model: modelId,
    reason,
    durationMs: Date.now() - startedAt,
  })
  return { healthy: false, checkedAt: Date.now(), reason }
}

function isStale(entry: ModelHealthEntry | undefined, now: number): boolean {
  if (!entry) return true
  return (
    now - entry.checkedAt >= (entry.healthy ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS)
  )
}

async function checkBatch(
  provider: ResolvedProviderConfig,
  modelIds: string[],
): Promise<void> {
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_CHECKS, modelIds.length) },
    async () => {
      while (cursor < modelIds.length) {
        const modelId = modelIds[cursor++]
        healthCache.set(
          modelCacheKey(provider, modelId),
          await probeModel(provider, modelId),
        )
      }
    },
  )
  await Promise.all(workers)
}

export async function testProviderModel(
  provider: ResolvedProviderConfig,
  modelId: string,
  options: { force?: boolean } = {},
): Promise<ModelHealthEntry> {
  const normalizedId = modelId.trim()
  if (!normalizedId) throw new Error("Model ID must not be empty")
  const key = modelCacheKey(provider, normalizedId)
  const cached = healthCache.get(key)
  if (!options.force && !isStale(cached, Date.now()))
    return cached as ModelHealthEntry
  const result = await probeModel(provider, normalizedId)
  healthCache.set(key, result)
  return result
}

export function getProviderModelHealth(
  provider: ResolvedProviderConfig,
  modelId: string,
): ModelHealthEntry | undefined {
  const entry = healthCache.get(modelCacheKey(provider, modelId))
  return entry ? { ...entry } : undefined
}

export async function filterHealthyProviderModels(
  provider: ResolvedProviderConfig,
  models: ModelRecord[],
  initialWaitMs = INITIAL_HEALTH_WAIT_MS,
): Promise<ModelRecord[]> {
  const healthManaged =
    provider.name === "bkg-api"
    || Array.isArray(provider.manualModels)
    || Array.isArray(provider.disabledModels)
  if (!healthManaged) return models
  const manualModels = provider.manualModels ?? []
  const candidates = [...models]
  const knownIds = new Set(
    candidates.map(readModelId).filter((id): id is string => !!id),
  )
  for (const id of manualModels) {
    if (!knownIds.has(id)) {
      candidates.push({ id, object: "model", owned_by: provider.name })
      knownIds.add(id)
    }
  }

  const disabled = new Set(provider.disabledModels ?? [])
  const ids = [
    ...new Set(candidates.map(readModelId).filter((id): id is string => !!id)),
  ].filter((id) => !disabled.has(id))
  const providerKey = providerCacheKey(provider)
  const staleIds = ids.filter((id) =>
    isStale(healthCache.get(modelCacheKey(provider, id)), Date.now()),
  )

  if (staleIds.length > 0) {
    let refresh = refreshes.get(providerKey)
    if (!refresh) {
      const task = checkBatch(provider, staleIds)
        .catch((error) => {
          logger.error("model.health.refresh.failed", {
            provider: provider.name,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          if (refreshes.get(providerKey) === task) {
            refreshes.delete(providerKey)
          }
        })
      refreshes.set(providerKey, task)
      refresh = task
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      refresh,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, initialWaitMs))
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
  }

  const healthy = new Set(
    ids.filter(
      (id) => healthCache.get(modelCacheKey(provider, id))?.healthy === true,
    ),
  )
  logger.info("model.health.catalog", {
    provider: provider.name,
    discovered: ids.length,
    healthy: healthy.size,
    rejected: ids.length - healthy.size,
  })
  return candidates.filter((model) => {
    const id = readModelId(model)
    return id !== undefined && healthy.has(id)
  })
}

export function getProviderModelHealthSnapshot(
  provider: ResolvedProviderConfig,
  modelIds: string[],
): Array<{ id: string; health: ModelHealthEntry | null }> {
  return modelIds.map((id) => ({
    id,
    health: getProviderModelHealth(provider, id) ?? null,
  }))
}
