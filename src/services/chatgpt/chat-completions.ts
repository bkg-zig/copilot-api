import consola from "consola"
import { randomUUID } from "node:crypto"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ToolCall,
} from "~/lib/types/chat-completions"

import {
  getUpstreamTransportConfig,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { createFallbackModel } from "~/lib/provider-model"
import { getTokenCount } from "~/lib/tokenizer"
import { fetchUpstreamWithLifecycle } from "~/services/upstream-http"

import type { ChatGPTFinishReason } from "./delta-stream"

import { ChatGPTWebDeltaDecoder } from "./delta-stream"
import {
  ChatGPTWebError,
  createChatGPTWebErrorBody,
  createChatGPTWebErrorResponse,
  createChatGPTWebUpstreamError,
  parseChatGPTWebErrorDetail,
} from "./errors"
import { requireChatGPTWebModel } from "./models"
import { buildChatGPTWebPrompt, type ChatGPTWebPrompt } from "./prompt"
import { createSentinelHeaders, fetchChatRequirements } from "./sentinel"
import { readServerSentEventData } from "./sse"
import { ToolCallStreamParser, type ParsedToolCall } from "./tool-calls"
import {
  buildChatGPTWebHeaders,
  forgetChatGPTWebSession,
  rememberChatGPTWebCookies,
  resolveChatGPTWebSession,
  resolveChatGPTWebUrl,
  type ChatGPTWebSession,
} from "./web-client"

/**
 * Serves a Chat Completions request through the ChatGPT web conversation
 * endpoint and answers in Chat Completions format (SSE chunks or JSON), so the
 * existing provider handlers translate it like any OpenAI-compatible upstream.
 */

const CONVERSATION_PATH = "/conversation"
/** Free accounts reject requests above roughly 100k characters (HTTP 413). */
const FREE_PLAN_MAX_PROMPT_CHARS = 100_000
const PAID_PLAN_MAX_PROMPT_CHARS = 480_000
const MAX_PROMPT_CHARS_ENV = "COPILOT_API_CHATGPT_WEB_MAX_PROMPT_CHARS"

type CompletionFinishReason = ChatGPTFinishReason | "tool_calls"

type CompletionEvent =
  | { call: ParsedToolCall; type: "tool_call" }
  | { finishReason: CompletionFinishReason; type: "done" }
  | { error: ChatGPTWebError; type: "error" }
  | { text: string; type: "text" }

export interface ChatGPTWebCompletionOptions {
  clientSignal?: AbortSignal
  fetch?: typeof globalThis.fetch
}

/** Character budget of one request, by plan; overridable via environment. */
export function resolveChatGPTWebPromptBudget(
  persona: string | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  const override = Number.parseInt(env[MAX_PROMPT_CHARS_ENV] ?? "", 10)
  if (Number.isFinite(override) && override > 0) return override
  if (!persona || persona.includes("free")) return FREE_PLAN_MAX_PROMPT_CHARS
  return PAID_PLAN_MAX_PROMPT_CHARS
}

function createPromptTooLongError(characters: number, budget: number) {
  return new ChatGPTWebError(
    400,
    "prompt_too_long",
    `prompt is too long: ${characters} characters > ${budget} maximum for ChatGPT web on this account. Compact the conversation or use a model with a larger context.`,
  )
}

/** Builds the prompt, shortening tool descriptions when it exceeds the budget. */
export function buildBudgetedChatGPTWebPrompt(
  payload: ChatCompletionsPayload,
  budget: number,
): ChatGPTWebPrompt {
  const full = buildChatGPTWebPrompt(payload)
  if (full.characterCount <= budget) return full
  const compacted = buildChatGPTWebPrompt(payload, { compactTools: true })
  if (compacted.characterCount <= budget) {
    consola.info(
      `chatgpt web: compacted tool descriptions (${full.characterCount} -> ${compacted.characterCount} characters, budget ${budget})`,
    )
    return compacted
  }
  throw createPromptTooLongError(compacted.characterCount, budget)
}

export function createConversationBody(
  prompt: ChatGPTWebPrompt,
  modelSlug: string,
): Record<string, unknown> {
  return {
    action: "next",
    conversation_mode: { kind: "primary_assistant" },
    // Temporary chat: nothing is stored in the account's history.
    history_and_training_disabled: true,
    messages: prompt.messages.map((message) => ({
      author: { role: message.role },
      content: { content_type: "text", parts: [message.text] },
      id: message.id,
      metadata: {},
    })),
    model: modelSlug,
    parent_message_id: "client-created-root",
    supported_encodings: ["v1"],
    supports_buffering: true,
    timezone_offset_min: new Date().getTimezoneOffset(),
  }
}

async function openConversation(
  session: ChatGPTWebSession,
  body: Record<string, unknown>,
  sentinelHeaders: Record<string, string>,
  options: ChatGPTWebCompletionOptions,
): Promise<Response> {
  const transport = getUpstreamTransportConfig()
  const init: RequestInit = {
    body: JSON.stringify(body),
    headers: buildChatGPTWebHeaders(session, CONVERSATION_PATH, {
      accept: "text/event-stream",
      "content-type": "application/json",
      ...sentinelHeaders,
    }),
    method: "POST",
  }
  const url = resolveChatGPTWebUrl(session, CONVERSATION_PATH)
  const response =
    options.fetch ?
      await options.fetch(url, { ...init, signal: options.clientSignal })
    : await fetchUpstreamWithLifecycle(url, init, {
        clientSignal: options.clientSignal,
        headersTimeoutMs: transport.headersTimeoutMs,
        streamInactivityTimeoutMs: transport.streamInactivityTimeoutMs,
      })
  rememberChatGPTWebCookies(session, response)

  if (response.status === 413) {
    const detail = parseChatGPTWebErrorDetail(await response.text())
    throw new ChatGPTWebError(
      400,
      "prompt_too_long",
      `prompt is too long for ChatGPT web${detail.message ? `: ${detail.message}` : ""}. Compact the conversation or use a model with a larger context.`,
    )
  }
  if (!response.ok) {
    throw await createChatGPTWebUpstreamError(response, "conversation")
  }
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream")) {
    const detail = parseChatGPTWebErrorDetail(await response.text())
    throw new ChatGPTWebError(
      502,
      "chatgpt_unexpected_response",
      `ChatGPT conversation returned ${contentType || "no content type"} instead of an event stream${detail.message ? `: ${detail.message}` : ""}.`,
    )
  }
  return response
}

/** Longest wait a client may sleep through instead of failing right away. */
const MAX_RETRY_AFTER_SECONDS = 60

function streamErrorOf(event: {
  code: string
  message: string
  resetAt?: string
}): ChatGPTWebError {
  if (event.code === "content_filter") {
    return new ChatGPTWebError(400, event.code, event.message)
  }
  if (event.code === "chatgpt_usage_limit") {
    const resetTime = event.resetAt ? Date.parse(event.resetAt) : Number.NaN
    const waitSeconds =
      Number.isFinite(resetTime) ?
        Math.max(1, Math.ceil((resetTime - Date.now()) / 1000))
      : undefined
    // Limits usually reset after hours; clients must not keep retrying them.
    return new ChatGPTWebError(
      429,
      event.code,
      event.message,
      waitSeconds !== undefined && waitSeconds <= MAX_RETRY_AFTER_SECONDS ?
        { retryAfter: String(waitSeconds) }
      : { shouldRetry: false },
    )
  }
  return new ChatGPTWebError(502, event.code, event.message)
}

/** Decodes the conversation stream into text, tool calls and the finish. */
async function* readCompletionEvents(
  response: Response,
  prompt: ChatGPTWebPrompt,
  allowParallel: boolean,
): AsyncGenerator<CompletionEvent> {
  const decoder = new ChatGPTWebDeltaDecoder({
    ignoredMessageIds: prompt.messages.map((message) => message.id),
  })
  const parser =
    prompt.toolNames.length > 0 ?
      new ToolCallStreamParser({ allowParallel, toolNames: prompt.toolNames })
    : undefined
  let lastMessageId: string | undefined

  const convert = function* (
    decoded: ReturnType<ChatGPTWebDeltaDecoder["push"]>,
  ): Generator<CompletionEvent, boolean> {
    for (const event of decoded) {
      if (event.type === "error") {
        yield { error: streamErrorOf(event), type: "error" }
        return true
      }
      if (event.type === "text") {
        // Separate consecutive visible messages of one turn.
        const separator =
          lastMessageId !== undefined && lastMessageId !== event.messageId ?
            "\n\n"
          : ""
        lastMessageId = event.messageId
        const text = separator + event.text
        if (!parser) {
          yield { text, type: "text" }
          continue
        }
        for (const parsed of parser.push(text)) yield parsed
        continue
      }
      for (const parsed of parser?.finish() ?? []) yield parsed
      yield {
        finishReason:
          parser && parser.toolCalls.length > 0 ?
            "tool_calls"
          : event.finishReason,
        type: "done",
      }
      return true
    }
    return false
  }

  if (response.body) {
    for await (const data of readServerSentEventData(response.body)) {
      if (yield* convert(decoder.push(data))) return
      // The backend may keep the connection open briefly after `[DONE]`.
      if (data.trim() === "[DONE]") break
    }
  }
  yield* convert(decoder.finish())
}

interface CompletionContext {
  completionId: string
  created: number
  includeUsage: boolean
  model: string
  promptTokens: Promise<number>
}

async function estimateTokens(
  messages: ChatCompletionsPayload["messages"],
): Promise<{ input: number; output: number }> {
  try {
    return await getTokenCount(
      { messages, model: "chatgpt-web" },
      createFallbackModel("chatgpt-web"),
    )
  } catch {
    const characters = messages.reduce(
      (total, message) =>
        total
        + (typeof message.content === "string" ? message.content.length : 0),
      0,
    )
    return { input: Math.ceil(characters / 4), output: 0 }
  }
}

async function estimatePromptTokens(prompt: ChatGPTWebPrompt): Promise<number> {
  const counts = await estimateTokens(
    prompt.messages.map((message) => ({
      content: message.text,
      role: message.role,
    })),
  )
  return counts.input + counts.output
}

async function estimateCompletionTokens(
  text: string,
  toolCalls: Array<ParsedToolCall>,
): Promise<number> {
  const serialized = [
    text,
    ...toolCalls.map((call) => `${call.name}${call.arguments}`),
  ].join("")
  if (!serialized) return 0
  const counts = await estimateTokens([
    { content: serialized, role: "assistant" },
  ])
  return counts.output
}

function toToolCall(call: ParsedToolCall): ToolCall {
  return {
    function: { arguments: call.arguments, name: call.name },
    id: call.id,
    type: "function",
  }
}

async function createUsage(
  context: CompletionContext,
  text: string,
  toolCalls: Array<ParsedToolCall>,
) {
  const promptTokens = await context.promptTokens
  const completionTokens = await estimateCompletionTokens(text, toolCalls)
  return {
    completion_tokens: completionTokens,
    prompt_tokens: promptTokens,
    total_tokens: promptTokens + completionTokens,
  }
}

async function respondJson(
  iterator: AsyncGenerator<CompletionEvent>,
  context: CompletionContext,
): Promise<Response> {
  let text = ""
  const toolCalls: Array<ParsedToolCall> = []
  let finishReason: CompletionFinishReason = "stop"
  for await (const event of iterator) {
    if (event.type === "error") throw event.error
    if (event.type === "text") text += event.text
    if (event.type === "tool_call") toolCalls.push(event.call)
    if (event.type === "done") finishReason = event.finishReason
  }
  const body: ChatCompletionResponse = {
    choices: [
      {
        finish_reason: finishReason,
        index: 0,
        logprobs: null,
        message: {
          content: text || null,
          role: "assistant",
          ...(toolCalls.length > 0 && {
            tool_calls: toolCalls.map(toToolCall),
          }),
        },
      },
    ],
    created: context.created,
    id: context.completionId,
    model: context.model,
    object: "chat.completion",
    usage: await createUsage(context, text, toolCalls),
  }
  return Response.json(body)
}

function createChunk(
  context: CompletionContext,
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    choices: [{ delta, finish_reason: finishReason, index: 0, logprobs: null }],
    created: context.created,
    id: context.completionId,
    model: context.model,
    object: "chat.completion.chunk",
  }
}

function encodeData(value: unknown): Uint8Array {
  const data = typeof value === "string" ? value : JSON.stringify(value)
  return new TextEncoder().encode(`data: ${data}\n\n`)
}

async function respondStream(
  iterator: AsyncGenerator<CompletionEvent>,
  context: CompletionContext,
): Promise<Response> {
  // Read up to the first output so failures before any content still become
  // a proper HTTP error instead of an empty stream.
  const first = await iterator.next()
  if (!first.done && first.value.type === "error") throw first.value.error

  let text = ""
  const toolCalls: Array<ParsedToolCall> = []
  let started = false
  let closed = false

  const encodeEvent = async (
    event: CompletionEvent,
  ): Promise<Array<Uint8Array>> => {
    const output: Array<Uint8Array> = []
    if (!started) {
      started = true
      output.push(
        encodeData(createChunk(context, { content: "", role: "assistant" })),
      )
    }
    switch (event.type) {
      case "text": {
        text += event.text
        output.push(encodeData(createChunk(context, { content: event.text })))
        break
      }
      case "tool_call": {
        const index = toolCalls.length
        toolCalls.push(event.call)
        output.push(
          encodeData(
            createChunk(context, {
              tool_calls: [
                {
                  function: {
                    arguments: event.call.arguments,
                    name: event.call.name,
                  },
                  id: event.call.id,
                  index,
                  type: "function",
                },
              ],
            }),
          ),
        )
        break
      }
      case "done": {
        output.push(encodeData(createChunk(context, {}, event.finishReason)))
        if (context.includeUsage) {
          output.push(
            encodeData({
              ...createChunk(context, {}),
              choices: [],
              usage: await createUsage(context, text, toolCalls),
            }),
          )
        }
        output.push(encodeData("[DONE]"))
        closed = true
        break
      }
      case "error": {
        consola.warn(`chatgpt web stream failed: ${event.error.message}`)
        output.push(encodeData(createChatGPTWebErrorBody(event.error)))
        closed = true
        break
      }
    }
    return output
  }

  let pendingFirst: CompletionEvent | undefined =
    first.done ? undefined : first.value
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!closed) {
          let event: CompletionEvent | undefined = pendingFirst
          pendingFirst = undefined
          if (!event) {
            const next = await iterator.next()
            if (next.done) break
            event = next.value
          }
          const chunks = await encodeEvent(event)
          for (const chunk of chunks) controller.enqueue(chunk)
          if (chunks.length > 0) return
        }
        // Release the upstream connection once the reply is complete.
        await iterator.return(undefined).catch(() => {})
        controller.close()
      } catch (error) {
        const failure =
          error instanceof ChatGPTWebError ? error : (
            new ChatGPTWebError(
              502,
              "chatgpt_stream_failed",
              `ChatGPT web stream failed: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            )
          )
        consola.warn(failure.message)
        controller.enqueue(encodeData(createChatGPTWebErrorBody(failure)))
        controller.close()
        await iterator.return(undefined).catch(() => {})
      }
    },
    async cancel() {
      await iterator.return(undefined).catch(() => {})
    },
  })
  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    },
  })
}

async function runChatGPTWebCompletion(
  providerConfig: ResolvedProviderConfig,
  payload: ChatCompletionsPayload,
  options: ChatGPTWebCompletionOptions,
): Promise<Response> {
  const session = await resolveChatGPTWebSession(providerConfig, {
    fetch: options.fetch,
    signal: options.clientSignal,
  })
  try {
    return await completeWithSession(session, payload, options)
  } catch (error) {
    if (error instanceof ChatGPTWebError && error.status === 401) {
      forgetChatGPTWebSession(session)
    }
    throw error
  }
}

async function completeWithSession(
  session: ChatGPTWebSession,
  payload: ChatCompletionsPayload,
  options: ChatGPTWebCompletionOptions,
): Promise<Response> {
  const model = await requireChatGPTWebModel(session, payload.model, {
    fetch: options.fetch,
    signal: options.clientSignal,
  })
  const requirements = await fetchChatRequirements(session, {
    fetch: options.fetch,
    signal: options.clientSignal,
  })
  const prompt = buildBudgetedChatGPTWebPrompt(
    payload,
    resolveChatGPTWebPromptBudget(requirements.persona),
  )
  const sentinelHeaders = await createSentinelHeaders(
    requirements,
    options.clientSignal,
  )
  const response = await openConversation(
    session,
    createConversationBody(prompt, model.slug),
    sentinelHeaders,
    options,
  )

  const context: CompletionContext = {
    completionId: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    created: Math.floor(Date.now() / 1000),
    includeUsage: payload.stream_options?.include_usage === true,
    model: payload.model,
    promptTokens: estimatePromptTokens(prompt),
  }
  const iterator = readCompletionEvents(
    response,
    prompt,
    payload.parallel_tool_calls !== false,
  )
  return payload.stream ?
      await respondStream(iterator, context)
    : await respondJson(iterator, context)
}

/**
 * Runs one Chat Completions request against ChatGPT web. Failures that are
 * known before streaming starts are returned as OpenAI-style error responses
 * with a matching status; client aborts and transport timeouts are rethrown
 * for the regular gateway error handling.
 */
export async function createChatGPTWebChatCompletion(
  providerConfig: ResolvedProviderConfig,
  payload: ChatCompletionsPayload,
  options: ChatGPTWebCompletionOptions = {},
): Promise<Response> {
  try {
    return await runChatGPTWebCompletion(providerConfig, payload, options)
  } catch (error) {
    if (error instanceof ChatGPTWebError) {
      consola.warn(`chatgpt web: ${error.code}: ${error.message}`)
      return createChatGPTWebErrorResponse(error)
    }
    throw error
  }
}
