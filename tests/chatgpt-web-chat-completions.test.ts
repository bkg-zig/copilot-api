import { afterEach, describe, expect, test } from "bun:test"

import type { ResolvedProviderConfig } from "~/lib/config"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Tool,
} from "~/lib/types/chat-completions"

import {
  buildBudgetedChatGPTWebPrompt,
  createChatGPTWebChatCompletion,
  createConversationBody,
  resolveChatGPTWebPromptBudget,
} from "~/services/chatgpt/chat-completions"
import { clearChatGPTCookieLogins } from "~/services/chatgpt/cookie-session"
import { clearChatGPTWebCatalogCache } from "~/services/chatgpt/models"
import { isProofAccepted } from "~/services/chatgpt/sentinel"

import {
  assistantReplyEvents,
  createChatGPTWebFetchMock,
  rejectionOf,
  sseBody,
  TEST_SESSION_COOKIE,
} from "./fixtures/chatgpt-web"

const providerConfig: ResolvedProviderConfig = {
  apiKey: "access-token",
  authType: "cookie",
  baseUrl: "https://chatgpt.example/backend-api",
  name: "chatgpt",
  type: "chatgpt",
}

const readTool: Tool = {
  function: {
    description: "Reads a file.",
    name: "Read",
    parameters: {
      properties: { file_path: { type: "string" } },
      type: "object",
    },
  },
  type: "function",
}

const BUDGET_ENV = "COPILOT_API_CHATGPT_WEB_MAX_PROMPT_CHARS"
const originalBudget = process.env[BUDGET_ENV]

afterEach(() => {
  clearChatGPTWebCatalogCache()
  if (originalBudget === undefined) delete process.env[BUDGET_ENV]
  else process.env[BUDGET_ENV] = originalBudget
})

function payload(
  overrides: Partial<ChatCompletionsPayload> = {},
): ChatCompletionsPayload {
  return {
    messages: [
      { content: "Be brief.", role: "system" },
      { content: "Say hello", role: "user" },
    ],
    model: "gpt-6",
    ...overrides,
  }
}

function eventStream(payloads: Array<unknown>): () => Response {
  return () =>
    new Response(sseBody(payloads), {
      headers: { "content-type": "text/event-stream" },
    })
}

async function readSse(response: Response): Promise<Array<string>> {
  const text = await response.text()
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => block.replace(/^data: /u, ""))
}

function parseChunks(data: Array<string>): Array<ChatCompletionChunk> {
  return data
    .filter((item) => item !== "[DONE]")
    .map((item) => JSON.parse(item) as ChatCompletionChunk)
}

describe("ChatGPT web chat completions", () => {
  test("answers a non-streaming request through the web conversation", async () => {
    const mock = createChatGPTWebFetchMock()
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload(),
      { fetch: mock.fetch },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as ChatCompletionResponse
    expect(body).toMatchObject({
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          message: { content: "Hello world", role: "assistant" },
        },
      ],
      model: "gpt-6",
      object: "chat.completion",
    })
    expect(body.id).toMatch(/^chatcmpl-[0-9a-f]{32}$/u)
    expect(body.choices[0]?.message.tool_calls).toBeUndefined()
    expect(body.usage?.prompt_tokens).toBeGreaterThan(0)
    expect(body.usage?.completion_tokens).toBeGreaterThan(0)
    expect(body.usage?.total_tokens).toBe(
      (body.usage?.prompt_tokens ?? 0) + (body.usage?.completion_tokens ?? 0),
    )

    expect(mock.requests.map((request) => request.url)).toEqual([
      "https://chatgpt.example/backend-api/models",
      "https://chatgpt.example/backend-api/sentinel/chat-requirements",
      "https://chatgpt.example/backend-api/conversation",
    ])
    const conversation = mock.requests[2]
    expect(conversation?.method).toBe("POST")
    expect(conversation?.headers.get("accept")).toBe("text/event-stream")
    expect(
      conversation?.headers.get("openai-sentinel-chat-requirements-token"),
    ).toBe("requirements-token")
    const proof = conversation?.headers.get("openai-sentinel-proof-token") ?? ""
    expect(proof.startsWith("gAAAAAB")).toBe(true)
    expect(isProofAccepted("seed", proof.slice(7), "0fff")).toBe(true)

    const sent = JSON.parse(conversation?.body ?? "{}") as {
      history_and_training_disabled: boolean
      messages: Array<{
        author: { role: string }
        content: { content_type: string; parts: Array<string> }
      }>
      model: string
      parent_message_id: string
    }
    expect(sent.model).toBe("gpt-6")
    expect(sent.history_and_training_disabled).toBe(true)
    expect(sent.parent_message_id).toBe("client-created-root")
    expect(sent.messages).toHaveLength(1)
    expect(sent.messages[0]?.author.role).toBe("user")
    expect(sent.messages[0]?.content.parts[0]).toBe(
      "<instructions>\nBe brief.\n</instructions>\n\n---\n\nSay hello",
    )
  })

  test("streams Chat Completions chunks with usage and [DONE]", async () => {
    const mock = createChatGPTWebFetchMock()
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ stream: true, stream_options: { include_usage: true } }),
      { fetch: mock.fetch },
    )
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const data = await readSse(response)
    expect(data.at(-1)).toBe("[DONE]")
    const chunks = parseChunks(data)
    expect(chunks[0]?.choices[0]?.delta).toEqual({
      content: "",
      role: "assistant",
    })
    expect(
      chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join(""),
    ).toBe("Hello world")
    const finish = chunks.find((chunk) => chunk.choices[0]?.finish_reason)
    expect(finish?.choices[0]?.finish_reason).toBe("stop")
    const usage = chunks.at(-1)
    expect(usage?.choices).toEqual([])
    expect(usage?.usage?.completion_tokens).toBeGreaterThan(0)
  })

  test("omits the usage chunk unless requested", async () => {
    const mock = createChatGPTWebFetchMock()
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ stream: true }),
      { fetch: mock.fetch },
    )
    const chunks = parseChunks(await readSse(response))
    expect(chunks.some((chunk) => chunk.usage)).toBe(false)
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop")
  })

  test("turns tool call blocks into streamed tool calls", async () => {
    const mock = createChatGPTWebFetchMock({
      conversation: eventStream(
        assistantReplyEvents([
          "Checking.\n<tool_",
          'call>\n{"name": "Read", "arguments": {"file_path": "/etc/hostname"}}\n</tool_call>',
          '\n<tool_call>{"name": "Read", "arguments": {"file_path": "/etc/hosts"}}</tool_call>',
        ]),
      ),
    })
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ stream: true, tools: [readTool] }),
      { fetch: mock.fetch },
    )
    const chunks = parseChunks(await readSse(response))
    expect(
      chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join(""),
    ).toBe("Checking.")
    const calls = chunks.flatMap(
      (chunk) => chunk.choices[0]?.delta.tool_calls ?? [],
    )
    expect(calls.map((call) => [call.index, call.function])).toEqual([
      [0, { arguments: '{"file_path":"/etc/hostname"}', name: "Read" }],
      [1, { arguments: '{"file_path":"/etc/hosts"}', name: "Read" }],
    ])
    expect(calls.every((call) => call.id?.startsWith("call_"))).toBe(true)
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls")

    const sent = JSON.parse(mock.requests[2]?.body ?? "{}") as {
      messages: Array<{ content: { parts: Array<string> } }>
    }
    expect(sent.messages[0]?.content.parts[0]).toContain("<client_tools>")
  })

  test("returns tool calls in non-streaming responses", async () => {
    const mock = createChatGPTWebFetchMock({
      conversation: eventStream(
        assistantReplyEvents([
          '<tool_call>{"name": "Read", "arguments": {"file_path": "/a"}}</tool_call>',
        ]),
      ),
    })
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ tools: [readTool] }),
      { fetch: mock.fetch },
    )
    const body = (await response.json()) as ChatCompletionResponse
    expect(body.choices[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [
          {
            function: { arguments: '{"file_path":"/a"}', name: "Read" },
            type: "function",
          },
        ],
      },
    })
  })

  test("separates consecutive visible messages and reports length", async () => {
    const mock = createChatGPTWebFetchMock({
      conversation: eventStream([
        ...assistantReplyEvents(["First."], { messageId: "m1" }).slice(0, 3),
        ...assistantReplyEvents(["Second."], {
          finishType: "max_tokens",
          messageId: "m2",
        }).slice(1),
      ]),
    })
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload(),
      { fetch: mock.fetch },
    )
    const body = (await response.json()) as ChatCompletionResponse
    expect(body.choices[0]?.message.content).toBe("First.\n\nSecond.")
    expect(body.choices[0]?.finish_reason).toBe("length")
  })

  test("rejects models that the account does not offer", async () => {
    const mock = createChatGPTWebFetchMock()
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ model: "gpt-6.1-terra" }),
      { fetch: mock.fetch },
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as {
      error: { code: string; message: string }
    }
    expect(body.error.code).toBe("model_not_found")
    expect(body.error.message).toContain("chatgpt/gpt-6-t-mini")
    expect(mock.requests).toHaveLength(1)
  })

  test("maps conversation HTTP failures", async () => {
    const cases: Array<{
      code: string
      response: () => Response
      retryAfter?: string
      status: number
    }> = [
      {
        code: "prompt_too_long",
        response: () =>
          Response.json(
            {
              detail: {
                code: "message_length_exceeds_limit",
                message: "Your message is too long.",
              },
            },
            { status: 413 },
          ),
        status: 400,
      },
      {
        code: "chatgpt_unauthorized",
        response: () => Response.json({ detail: "expired" }, { status: 401 }),
        status: 401,
      },
      {
        code: "chatgpt_rate_limited",
        response: () =>
          Response.json(
            { detail: "slow down" },
            { headers: { "retry-after": "60" }, status: 429 },
          ),
        retryAfter: "60",
        status: 429,
      },
      {
        code: "chatgpt_unexpected_response",
        response: () => Response.json({ detail: "maintenance" }),
        status: 502,
      },
    ]
    for (const entry of cases) {
      clearChatGPTWebCatalogCache()
      const mock = createChatGPTWebFetchMock({ conversation: entry.response })
      const response = await createChatGPTWebChatCompletion(
        providerConfig,
        payload({ stream: true }),
        { fetch: mock.fetch },
      )
      expect(response.status).toBe(entry.status)
      expect(response.headers.get("retry-after")).toBe(entry.retryAfter ?? null)
      const body = (await response.json()) as {
        error: { code: string; message: string }
      }
      expect(body.error.code).toBe(entry.code)
      if (entry.code === "prompt_too_long") {
        expect(body.error.message).toStartWith("prompt is too long")
      }
    }
  })

  test("returns an HTTP error when the stream fails before any output", async () => {
    const mock = createChatGPTWebFetchMock({
      conversation: eventStream([
        '"v1"',
        { moderation_response: { blocked: true }, type: "moderation" },
      ]),
    })
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ stream: true }),
      { fetch: mock.fetch },
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "content_filter" },
    })

    clearChatGPTWebCatalogCache()
    const incomplete = createChatGPTWebFetchMock({
      conversation: eventStream(['"v1"']),
    })
    const json = await createChatGPTWebChatCompletion(
      providerConfig,
      payload(),
      { fetch: incomplete.fetch },
    )
    expect(json.status).toBe(502)
    expect(await json.json()).toMatchObject({
      error: { code: "chatgpt_stream_incomplete" },
    })
  })

  test("reports exhausted usage limits as rate limits clients must not retry", async () => {
    const limitEvents = (resetAfter: string) =>
      eventStream([
        '"v1"',
        {
          error: "You've hit your limit. Please try again later.",
          error_code: "usage_limit",
          message: null,
        },
        {
          limits_progress: [
            { feature_name: "reason", remaining: 0, reset_after: resetAfter },
          ],
          type: "conversation_detail_metadata",
        },
        "[DONE]",
      ])
    const later = new Date(Date.now() + 4 * 3_600_000).toISOString()
    const mock = createChatGPTWebFetchMock({ conversation: limitEvents(later) })
    const streamed = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ stream: true }),
      { fetch: mock.fetch },
    )
    expect(streamed.status).toBe(429)
    expect(streamed.headers.get("x-should-retry")).toBe("false")
    expect(streamed.headers.get("retry-after")).toBeNull()
    const body = (await streamed.json()) as {
      error: { code: string; message: string; type: string }
    }
    expect(body.error).toMatchObject({
      code: "chatgpt_usage_limit",
      type: "rate_limit_error",
    })
    expect(body.error.message).toContain(
      "The ChatGPT web limit 'reason' resets at",
    )

    const soon = createChatGPTWebFetchMock({
      conversation: limitEvents(new Date(Date.now() + 20_000).toISOString()),
    })
    const json = await createChatGPTWebChatCompletion(
      providerConfig,
      payload(),
      { fetch: soon.fetch },
    )
    expect(json.status).toBe(429)
    const retryAfter = Number(json.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(20)
    expect(json.headers.get("x-should-retry")).toBeNull()
  })

  test("reports a turn without an answer instead of an empty reply", async () => {
    const mock = createChatGPTWebFetchMock({
      conversation: eventStream([
        '"v1"',
        { type: "message_stream_complete" },
        "[DONE]",
      ]),
    })
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload(),
      { fetch: mock.fetch },
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: { code: "chatgpt_empty_response" },
    })
  })

  test("signs in again after the backend rejected the cookie login", async () => {
    clearChatGPTCookieLogins()
    const cookieProvider: ResolvedProviderConfig = {
      ...providerConfig,
      apiKey: "",
      cookie: TEST_SESSION_COOKIE,
    }
    let rejected = true
    const mock = createChatGPTWebFetchMock({
      requirements: () =>
        rejected ?
          Response.json({ detail: "token revoked" }, { status: 401 })
        : Response.json({ proofofwork: { required: false }, token: "t" }),
    })
    const failed = await createChatGPTWebChatCompletion(
      cookieProvider,
      payload(),
      { fetch: mock.fetch },
    )
    expect(failed.status).toBe(401)
    rejected = false
    const answered = await createChatGPTWebChatCompletion(
      cookieProvider,
      payload(),
      { fetch: mock.fetch },
    )
    expect(answered.status).toBe(200)
    const conversation = mock.requests.at(-1)
    expect(conversation?.headers.get("cookie")).toContain(
      "__Secure-next-auth.session-token=rotated-session",
    )
    expect(
      mock.requests.filter((request) =>
        request.url.endsWith("/api/auth/session"),
      ),
    ).toHaveLength(2)
    clearChatGPTCookieLogins()
  })

  test("reports a failure after streamed output as an error chunk", async () => {
    const mock = createChatGPTWebFetchMock({
      conversation: eventStream([
        ...assistantReplyEvents(["Partial"]).slice(0, 3),
        { error: "Conversation not found", type: "error" },
      ]),
    })
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ stream: true }),
      { fetch: mock.fetch },
    )
    expect(response.status).toBe(200)
    const data = await readSse(response)
    expect(data).not.toContain("[DONE]")
    expect(JSON.parse(data.at(-1) ?? "{}")).toEqual({
      error: {
        code: "chatgpt_stream_error",
        message: "Conversation not found",
        type: "api_error",
      },
    })
    expect(
      parseChunks(data.slice(0, -1))
        .map((chunk) => chunk.choices[0]?.delta.content ?? "")
        .join(""),
    ).toBe("Partial")
  })

  test("reports transport failures during streaming", async () => {
    const encoder = new TextEncoder()
    const mock = createChatGPTWebFetchMock({
      conversation: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  sseBody(assistantReplyEvents(["Hi"]).slice(0, 3)),
                ),
              )
            },
            pull(controller) {
              controller.error(new Error("socket closed"))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ stream: true }),
      { fetch: mock.fetch },
    )
    const data = await readSse(response)
    expect(JSON.parse(data.at(-1) ?? "{}")).toMatchObject({
      error: {
        code: "chatgpt_stream_failed",
        message: "ChatGPT web stream failed: socket closed",
      },
    })
  })

  test("cancels the upstream stream when the client disconnects", async () => {
    let cancelled = false
    const encoder = new TextEncoder()
    const mock = createChatGPTWebFetchMock({
      conversation: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  sseBody(assistantReplyEvents(["Hi"]).slice(0, 3)),
                ),
              )
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const response = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ stream: true }),
      { fetch: mock.fetch },
    )
    const reader = response.body?.getReader()
    const first = await reader?.read()
    expect(
      new TextDecoder().decode(first?.value as Uint8Array | undefined),
    ).toContain('"role":"assistant"')
    await reader?.cancel()
    expect(cancelled).toBe(true)
  })

  test("compacts tools or rejects prompts above the character budget", async () => {
    const longTool: Tool = {
      function: {
        description: `Line one.\n\n${"x".repeat(5000)}`,
        name: "Read",
        parameters: { type: "object" },
      },
      type: "function",
    }
    process.env[BUDGET_ENV] = "3000"
    const mock = createChatGPTWebFetchMock()
    const compacted = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ tools: [longTool] }),
      { fetch: mock.fetch },
    )
    expect(compacted.status).toBe(200)
    const sent = JSON.parse(mock.requests[2]?.body ?? "{}") as {
      messages: Array<{ content: { parts: Array<string> } }>
    }
    expect(sent.messages[0]?.content.parts[0]).not.toContain("xxxxxxxx")

    process.env[BUDGET_ENV] = "50"
    const tooLong = createChatGPTWebFetchMock()
    const rejected = await createChatGPTWebChatCompletion(
      providerConfig,
      payload({ tools: [longTool] }),
      { fetch: tooLong.fetch },
    )
    expect(rejected.status).toBe(400)
    const body = (await rejected.json()) as { error: { message: string } }
    expect(body.error.message).toStartWith("prompt is too long:")
    expect(
      tooLong.requests.some((request) => request.url.endsWith("/conversation")),
    ).toBe(false)
  })

  test("rethrows unexpected transport errors", async () => {
    const failing = (() =>
      Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch
    const error = await rejectionOf(
      createChatGPTWebChatCompletion(providerConfig, payload(), {
        fetch: failing,
      }),
    )
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe("fetch failed")
  })
})

describe("ChatGPT web prompt budget", () => {
  test("depends on the plan persona and an override", () => {
    expect(resolveChatGPTWebPromptBudget("chatgpt-freeaccount", {})).toBe(
      100_000,
    )
    expect(resolveChatGPTWebPromptBudget(undefined, {})).toBe(100_000)
    expect(resolveChatGPTWebPromptBudget("chatgpt-paid", {})).toBe(480_000)
    expect(
      resolveChatGPTWebPromptBudget("chatgpt-paid", { [BUDGET_ENV]: "1234" }),
    ).toBe(1234)
    expect(
      resolveChatGPTWebPromptBudget("chatgpt-paid", { [BUDGET_ENV]: "nope" }),
    ).toBe(480_000)
  })

  test("keeps full tool descriptions when they fit", () => {
    const prompt = buildBudgetedChatGPTWebPrompt(
      payload({ tools: [readTool] }),
      100_000,
    )
    expect(prompt.compactedTools).toBe(false)
    expect(createConversationBody(prompt, "gpt-6")).toMatchObject({
      action: "next",
      conversation_mode: { kind: "primary_assistant" },
      model: "gpt-6",
      supported_encodings: ["v1"],
    })
  })
})
