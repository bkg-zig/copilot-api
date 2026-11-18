import fs from "node:fs"
import path from "node:path"

import type { Model, ModelsResponse } from "~/lib/types/models"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import { writeFileAtomically } from "~/lib/atomic-file"
import { buildCodexRequestHeaders } from "~/services/codex/create-responses"
import { CODEX_API_BASE_URL } from "~/services/codex/constants"

const DEFAULT_CLIENT_VERSION = "0.155.0"
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BYTES = 1_024 * 1_024
const CACHE_VERSION = 1

export interface ChatGPTModelLoadOptions {
  baseUrl?: string
  cachePath?: string
  clientVersion?: string
  fetch?: typeof globalThis.fetch
  forceRefresh?: boolean
  accountId?: string
  now?: () => number
}

interface ChatGPTModelCache {
  version: typeof CACHE_VERSION
  fetchedAt: string
  accountId?: string
  baseUrl: string
  models: Array<Model>
}

const EMPTY_MODELS: ModelsResponse = {
  object: "list",
  data: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function getPositiveNumber(...values: Array<unknown>): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value)
    }
    if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
      const parsed = Number(value)
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
    }
  }
  return undefined
}

function getStringArray(value: unknown): Array<string> | undefined {
  if (!Array.isArray(value)) return undefined
  const result = value
    .map((item) => getString(item))
    .filter((item): item is string => item !== undefined)
  return result.length > 0 ? [...new Set(result)] : undefined
}

function normalizeBaseUrl(baseUrl: string = CODEX_API_BASE_URL): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "")
  if (!trimmed) return CODEX_API_BASE_URL
  if (trimmed.endsWith("/codex/models")) return trimmed
  if (trimmed.endsWith("/codex")) return `${trimmed}/models`
  return `${trimmed}/codex/models`
}

function getCachePath(options: ChatGPTModelLoadOptions): string {
  return (
    options.cachePath
    ?? process.env.COPILOT_API_CHATGPT_MODELS_CACHE_PATH?.trim()
    ?? path.join(PATHS.APP_DIR, "chatgpt_models_cache.json")
  )
}

function getAccountId(options: ChatGPTModelLoadOptions): string | undefined {
  return options.accountId?.trim() || state.codexAccountId?.trim() || undefined
}

function modelInputModalities(
  record: Record<string, unknown>,
): Array<"text" | "image"> {
  const raw = getStringArray(record.input_modalities)
    ?? getStringArray(record.inputModalities) ?? ["text"]
  const modalities = raw.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  )
  return modalities.length > 0 ? modalities : ["text"]
}

function normalizeChatGPTModel(record: Record<string, unknown>): Model | null {
  const id =
    getString(record.slug) ?? getString(record.id) ?? getString(record.model)
  if (!id) return null

  const visibility = getString(record.visibility)
  if (visibility && visibility !== "list") return null

  const inputModalities = modelInputModalities(record)
  const contextWindow = getPositiveNumber(
    record.context_window,
    record.contextWindow,
    record.max_context_window,
    record.max_context_window_tokens,
    record.context_length,
    record.max_model_len,
  )
  const maxOutputTokens = getPositiveNumber(
    record.max_output_tokens,
    record.maxOutputTokens,
  )
  const maxPromptTokens = getPositiveNumber(
    record.max_prompt_tokens,
    record.maxPromptTokens,
    contextWindow,
  )
  const reasoningEfforts = getStringArray(record.supported_reasoning_levels)
    ?? getStringArray(record.reasoning_efforts)
    ?? getStringArray(record.reasoningEfforts) ?? [
      "low",
      "medium",
      "high",
      "xhigh",
    ]
  const supportsVision = inputModalities.includes("image")
  const limits = {
    ...(contextWindow ? { max_context_window_tokens: contextWindow } : {}),
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    ...(maxPromptTokens ? { max_prompt_tokens: maxPromptTokens } : {}),
  }

  return {
    capabilities: {
      family: "gpt",
      limits,
      object: "model_capabilities",
      supports: {
        adaptive_thinking: true,
        parallel_tool_calls: true,
        reasoning_effort: reasoningEfforts,
        streaming: true,
        tool_calls: true,
        vision: supportsVision,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name:
      getString(record.display_name)
      ?? getString(record.displayName)
      ?? getString(record.name)
      ?? id,
    object: "model",
    preview: record.preview === true,
    supported_endpoints: ["/v1/messages", "/v1/responses"],
    vendor: "openai",
    version: "chatgpt",
  }
}

function getModelRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord)
  }
  if (!isRecord(value)) return []
  for (const key of ["models", "data", "items", "result"]) {
    const records = value[key]
    if (Array.isArray(records)) return records.filter(isRecord)
  }
  return []
}

export function parseChatGPTModelsPayload(value: unknown): ModelsResponse {
  const seen = new Set<string>()
  const data = getModelRecords(value).flatMap((record) => {
    const model = normalizeChatGPTModel(record)
    if (!model || seen.has(model.id)) return []
    seen.add(model.id)
    return [model]
  })
  return { object: "list", data }
}

function isModel(value: unknown): value is Model {
  return (
    isRecord(value)
    && typeof value.id === "string"
    && value.id.trim().length > 0
    && isRecord(value.capabilities)
  )
}

function readCachedModels(options: ChatGPTModelLoadOptions): ModelsResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      fs.readFileSync(getCachePath(options), "utf8"),
    ) as unknown
  } catch {
    return EMPTY_MODELS
  }
  if (!isRecord(parsed) || parsed.version !== CACHE_VERSION) return EMPTY_MODELS

  const expectedAccountId = getAccountId(options)
  const cachedAccountId = getString(parsed.accountId)
  if (
    expectedAccountId
    && cachedAccountId
    && expectedAccountId !== cachedAccountId
  ) {
    return EMPTY_MODELS
  }
  const cachedBaseUrl = getString(parsed.baseUrl)
  if (cachedBaseUrl && cachedBaseUrl !== normalizeBaseUrl(options.baseUrl)) {
    return EMPTY_MODELS
  }

  const models =
    Array.isArray(parsed.models) ? parsed.models.filter(isModel) : []
  return models.length > 0 ? { object: "list", data: models } : EMPTY_MODELS
}

function writeCachedModels(
  models: ModelsResponse,
  options: ChatGPTModelLoadOptions,
): void {
  const cache: ChatGPTModelCache = {
    version: CACHE_VERSION,
    fetchedAt: new Date((options.now ?? Date.now)()).toISOString(),
    accountId: getAccountId(options),
    baseUrl: normalizeBaseUrl(options.baseUrl),
    models: models.data,
  }
  try {
    writeFileAtomically(
      getCachePath(options),
      `${JSON.stringify(cache, null, 2)}\n`,
    )
  } catch {
    // A read-only cache must not turn an otherwise successful model request into
    // an outage. The live response is still returned to the caller.
  }
}

async function readBoundedBody(response: Response): Promise<unknown> {
  const body = response.body as ReadableStream<Uint8Array> | null
  const reader = body?.getReader()
  if (!reader) return await response.json()

  const chunks: Array<Uint8Array> = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error("ChatGPT model catalog response is too large")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function resolveClientVersion(options: ChatGPTModelLoadOptions): string {
  return (
    options.clientVersion?.trim()
    || process.env.COPILOT_API_CHATGPT_MODELS_CLIENT_VERSION?.trim()
    || DEFAULT_CLIENT_VERSION
  )
}

export function resolveChatGPTModelsUrl(
  baseUrl: string = CODEX_API_BASE_URL,
  clientVersion: string = DEFAULT_CLIENT_VERSION,
): string {
  const url = new URL(normalizeBaseUrl(baseUrl))
  url.searchParams.set("client_version", clientVersion)
  return url.toString()
}

export async function refreshChatGPTModels(
  requestHeaders: Headers,
  options: ChatGPTModelLoadOptions = {},
): Promise<ModelsResponse> {
  const headers = buildCodexRequestHeaders(requestHeaders)
  headers.set("accept", "application/json")
  headers.set("openai-beta", "responses=experimental")
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(
    resolveChatGPTModelsUrl(options.baseUrl, resolveClientVersion(options)),
    {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    },
  )
  if (!response.ok) {
    throw new Error(
      `ChatGPT model catalog request failed with ${response.status}`,
    )
  }

  const models = parseChatGPTModelsPayload(await readBoundedBody(response))
  if (models.data.length === 0) {
    throw new Error("ChatGPT model catalog contained no visible models")
  }
  writeCachedModels(models, options)
  return models
}

export function getModels(
  options: ChatGPTModelLoadOptions = {},
): ModelsResponse {
  return readCachedModels(options)
}

export async function loadModels(
  requestHeaders: Headers,
  options: ChatGPTModelLoadOptions = {},
): Promise<ModelsResponse> {
  const cached = readCachedModels(options)
  if (cached.data.length > 0 && !options.forceRefresh) return cached

  try {
    return await refreshChatGPTModels(requestHeaders, options)
  } catch {
    return cached
  }
}
