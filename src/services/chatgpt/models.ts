import type { Model } from "~/lib/types/models"

import { ChatGPTWebError, createChatGPTWebUpstreamError } from "./errors"
import {
  buildChatGPTWebHeaders,
  createChatGPTWebSignal,
  forgetChatGPTWebSession,
  rememberChatGPTWebCookies,
  resolveChatGPTWebSession,
  resolveChatGPTWebUrl,
  type ChatGPTWebCredentials,
  type ChatGPTWebSession,
} from "./web-client"

/**
 * Model catalog of the ChatGPT web app (`/backend-api/models`). It differs
 * per account and plan, so the `chatgpt/*` model list is read from the
 * account instead of reusing the static Codex catalog.
 */

const MODELS_PATH = "/models"
const MODELS_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 16
/** Output budget the web app grants per turn; not reported by the catalog. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384
const EXCLUDED_TAGS = new Set(["hidden"])
// Deep Research runs for minutes and returns reports, not chat turns.
const EXCLUDED_SLUGS = new Set(["research"])

export interface ChatGPTWebModel {
  contextWindow?: number
  displayName: string
  reasoning: boolean
  slug: string
}

export interface ChatGPTWebCatalog {
  defaultSlug?: string
  models: Array<ChatGPTWebModel>
}

interface CacheEntry {
  catalog: ChatGPTWebCatalog
  expiresAt: number
}

const catalogCache = new Map<string, CacheEntry>()
const pendingLoads = new Map<string, Promise<ChatGPTWebCatalog>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function stringsOf(value: unknown): Array<string> {
  return Array.isArray(value) ?
      value.filter((item): item is string => typeof item === "string")
    : []
}

/** Category labels (e.g. "Instant", "Thinking mini") keyed by model slug. */
function readCategoryLabels(categories: unknown): Map<string, string> {
  const labels = new Map<string, string>()
  if (!Array.isArray(categories)) return labels
  for (const category of categories) {
    if (!isRecord(category)) continue
    const label = stringOf(category.human_category_name)
    if (!label) continue
    const slugs = [
      stringOf(category.default_model),
      ...stringsOf(category.supported_models),
    ]
    for (const slug of slugs) {
      if (slug && !labels.has(slug)) labels.set(slug, label)
    }
  }
  return labels
}

function createDisplayName(
  slug: string,
  title: string | undefined,
  categoryLabel: string | undefined,
): string {
  if (!title) return slug
  if (categoryLabel && categoryLabel !== title) {
    return `${title} ${categoryLabel}`
  }
  if (categoryLabel) return title
  // Several slugs share one marketing title; keep them distinguishable.
  return `${title} [${slug}]`
}

export function parseChatGPTWebCatalog(body: unknown): ChatGPTWebCatalog {
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new ChatGPTWebError(
      502,
      "chatgpt_models_invalid",
      "ChatGPT returned an unexpected model catalog.",
    )
  }
  const labels = readCategoryLabels(body.categories)
  const models: Array<ChatGPTWebModel> = []
  const seen = new Set<string>()
  for (const entry of body.models) {
    if (!isRecord(entry)) continue
    const slug = stringOf(entry.slug)
    if (!slug || seen.has(slug) || EXCLUDED_SLUGS.has(slug)) continue
    if (stringsOf(entry.tags).some((tag) => EXCLUDED_TAGS.has(tag))) continue
    seen.add(slug)
    const maxTokens = entry.max_tokens
    models.push({
      contextWindow:
        typeof maxTokens === "number" && maxTokens > 0 ?
          Math.floor(maxTokens)
        : undefined,
      displayName: createDisplayName(
        slug,
        stringOf(entry.title),
        labels.get(slug),
      ),
      reasoning: entry.reasoning_type === "reasoning",
      slug,
    })
  }
  const defaultSlug = stringOf(body.default_model_slug)
  return {
    defaultSlug: defaultSlug && seen.has(defaultSlug) ? defaultSlug : undefined,
    models,
  }
}

function getCacheKey(session: ChatGPTWebSession): string {
  return `${session.backendUrl}#${session.identityKey}`
}

export interface LoadChatGPTWebCatalogOptions {
  fetch?: typeof globalThis.fetch
  forceRefresh?: boolean
  now?: () => number
  signal?: AbortSignal
}

async function fetchCatalog(
  session: ChatGPTWebSession,
  options: LoadChatGPTWebCatalogOptions,
): Promise<ChatGPTWebCatalog> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(resolveChatGPTWebUrl(session, MODELS_PATH), {
    headers: buildChatGPTWebHeaders(session, MODELS_PATH),
    method: "GET",
    signal: createChatGPTWebSignal(MODELS_TIMEOUT_MS, options.signal),
  })
  rememberChatGPTWebCookies(session, response)
  if (!response.ok) {
    throw await createChatGPTWebUpstreamError(response, "model catalog")
  }
  return parseChatGPTWebCatalog(await response.json())
}

export async function loadChatGPTWebCatalog(
  session: ChatGPTWebSession,
  options: LoadChatGPTWebCatalogOptions = {},
): Promise<ChatGPTWebCatalog> {
  const now = options.now ?? Date.now
  const key = getCacheKey(session)
  const cached = catalogCache.get(key)
  if (!options.forceRefresh && cached && cached.expiresAt > now()) {
    return cached.catalog
  }
  const pending = pendingLoads.get(key)
  if (pending) return await pending

  const load = fetchCatalog(session, options)
    .then((catalog) => {
      if (catalogCache.size >= MAX_CACHE_ENTRIES && !catalogCache.has(key)) {
        const oldest = catalogCache.keys().next().value
        if (oldest !== undefined) catalogCache.delete(oldest)
      }
      catalogCache.set(key, { catalog, expiresAt: now() + CACHE_TTL_MS })
      return catalog
    })
    .finally(() => {
      pendingLoads.delete(key)
    })
  pendingLoads.set(key, load)
  return await load
}

export function clearChatGPTWebCatalogCache(): void {
  catalogCache.clear()
  pendingLoads.clear()
}

export function toChatGPTWebGatewayModel(model: ChatGPTWebModel): Model {
  const contextWindow = model.contextWindow
  return {
    capabilities: {
      family: "gpt",
      limits: {
        max_context_window_tokens: contextWindow,
        max_output_tokens:
          contextWindow === undefined ?
            DEFAULT_MAX_OUTPUT_TOKENS
          : Math.min(DEFAULT_MAX_OUTPUT_TOKENS, contextWindow),
        max_prompt_tokens: contextWindow,
      },
      object: "model_capabilities",
      supports: {
        parallel_tool_calls: true,
        streaming: true,
        tool_calls: true,
        vision: false,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
    id: model.slug,
    model_picker_enabled: true,
    name: model.displayName,
    object: "model",
    preview: false,
    supported_endpoints: [
      "/v1/messages",
      "/v1/chat/completions",
      "/v1/responses",
    ],
    vendor: "openai",
    version: "chatgpt-web",
  }
}

/** Gateway model records of the signed-in account's web catalog. */
export async function getChatGPTWebModels(
  credentials: ChatGPTWebCredentials,
  options: LoadChatGPTWebCatalogOptions = {},
): Promise<Array<Model>> {
  const session = await resolveChatGPTWebSession(credentials, {
    fetch: options.fetch,
    now: options.now,
    signal: options.signal,
  })
  try {
    const catalog = await loadChatGPTWebCatalog(session, options)
    return catalog.models.map((model) => toChatGPTWebGatewayModel(model))
  } catch (error) {
    if (error instanceof ChatGPTWebError && error.status === 401) {
      forgetChatGPTWebSession(session)
    }
    throw error
  }
}

/**
 * Returns the catalog entry of `slug`. The web backend silently answers
 * unknown slugs with its default model, so they are rejected up front.
 */
export async function requireChatGPTWebModel(
  session: ChatGPTWebSession,
  slug: string,
  options: LoadChatGPTWebCatalogOptions = {},
): Promise<ChatGPTWebModel> {
  const catalog = await loadChatGPTWebCatalog(session, options)
  const model = catalog.models.find((entry) => entry.slug === slug)
  if (model) return model
  const available = catalog.models.map((entry) => `chatgpt/${entry.slug}`)
  throw new ChatGPTWebError(
    400,
    "model_not_found",
    `The model 'chatgpt/${slug}' is not available in ChatGPT web for this account. Available: ${available.join(", ") || "none"}.`,
  )
}
