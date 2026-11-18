import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import type {
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/lib/types/anthropic"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type { ResponsesPayload } from "~/lib/types/responses"

import { forwardError } from "~/lib/error"
import * as providerResolver from "~/lib/provider-resolver"
import * as tokenUsage from "~/lib/token-usage"
import { getProviderModelRecords } from "~/routes/models/model-discovery"
import { handleProviderChatCompletionsForProvider } from "~/routes/provider/chat-completions/handler"
import {
  handleProviderMessages,
  providerMessagesHandlerDependencies,
} from "~/routes/provider/messages/handler"
import { providerModelRoutes } from "~/routes/provider/models/route"
import {
  handleProviderResponsesForProvider,
  providerResponsesHandlerDependencies,
} from "~/routes/provider/responses/handler"
import { responsesMessagesDependencies } from "~/routes/responses/messages-handler"
import { clearChatGPTCookieLogins } from "~/services/chatgpt/cookie-session"
import { clearChatGPTWebCatalogCache } from "~/services/chatgpt/models"

import {
  assistantReplyEvents,
  createChatGPTWebFetchMock,
  sseBody,
  TEST_SESSION_COOKIE,
} from "./fixtures/chatgpt-web"

const provider: ResolvedProviderConfig = {
  apiKey: "",
  authType: "cookie",
  baseUrl: "https://chatgpt.com/backend-api",
  cookie: TEST_SESSION_COOKIE,
  name: "chatgpt",
  type: "chatgpt",
}

const originalFetch = globalThis.fetch
const originalMessagesResolve =
  providerMessagesHandlerDependencies.resolveProviderConfig
const originalResponsesResolve =
  providerResponsesHandlerDependencies.resolveProviderConfig
const originalHandleCompletionPayload =
  responsesMessagesDependencies.handleCompletionPayload
const recordUsage = mock((_usage: tokenUsage.UsageTokens) => {})
const restorers: Array<() => void> = []

function useWebBackend(
  options: Parameters<typeof createChatGPTWebFetchMock>[0] = {},
) {
  const backend = createChatGPTWebFetchMock(options)
  globalThis.fetch = backend.fetch
  return backend
}

function createApp() {
  const app = new Hono()
  app.onError((error, c) => forwardError(c, error))
  app.post("/:provider/v1/messages", handleProviderMessages)
  app.post(
    "/:provider/v1/chat/completions",
    async (c) =>
      await handleProviderChatCompletionsForProvider(c, {
        payload: await c.req.json<ChatCompletionsPayload>(),
        provider: c.req.param("provider"),
      }),
  )
  app.post(
    "/:provider/v1/responses",
    async (c) =>
      await handleProviderResponsesForProvider(c, {
        payload: await c.req.json<ResponsesPayload>(),
        provider: c.req.param("provider"),
      }),
  )
  app.route("/:provider/v1/models", providerModelRoutes)
  return app
}

function post(path: string, body: unknown) {
  return createApp().request(path, {
    body: JSON.stringify(body),
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    method: "POST",
  })
}

function parseAnthropicSse(text: string): Array<AnthropicStreamEventData> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as AnthropicStreamEventData)
}

beforeEach(() => {
  clearChatGPTWebCatalogCache()
  clearChatGPTCookieLogins()
  providerMessagesHandlerDependencies.resolveProviderConfig = () =>
    Promise.resolve(provider)
  providerResponsesHandlerDependencies.resolveProviderConfig = () =>
    Promise.resolve(provider)
  const resolverSpy = spyOn(
    providerResolver,
    "resolveProviderConfig",
  ).mockResolvedValue(provider)
  const recorderSpy = spyOn(
    tokenUsage,
    "createProviderTokenUsageRecorder",
  ).mockImplementation(() => recordUsage)
  restorers.push(
    () => resolverSpy.mockRestore(),
    () => recorderSpy.mockRestore(),
  )
  recordUsage.mockClear()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  providerMessagesHandlerDependencies.resolveProviderConfig =
    originalMessagesResolve
  providerResponsesHandlerDependencies.resolveProviderConfig =
    originalResponsesResolve
  responsesMessagesDependencies.handleCompletionPayload =
    originalHandleCompletionPayload
  while (restorers.length > 0) restorers.pop()?.()
})

describe("chatgpt provider routes", () => {
  test("serves Anthropic messages through the ChatGPT web transport", async () => {
    const backend = useWebBackend()
    const response = await post("/chatgpt/v1/messages", {
      max_tokens: 100,
      messages: [{ content: "Say hello", role: "user" }],
      model: "gpt-6",
      system: "Be brief.",
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as AnthropicResponse
    expect(body.content).toEqual([{ text: "Hello world", type: "text" }])
    expect(body.stop_reason).toBe("end_turn")
    expect(body.usage.output_tokens).toBeGreaterThan(0)
    expect(
      backend.requests.map((request) => new URL(request.url).pathname),
    ).toEqual([
      "/api/auth/session",
      "/backend-api/models",
      "/backend-api/sentinel/chat-requirements",
      "/backend-api/conversation",
    ])
    // The ChatGPT web login signs every request; no Codex token is involved.
    expect(backend.requests[0]?.headers.get("cookie")).toBe(TEST_SESSION_COOKIE)
    const conversation = backend.requests.at(-1)
    expect(conversation?.headers.get("authorization")).toStartWith("Bearer ey")
    expect(conversation?.headers.get("cookie")).toContain(
      "__Secure-next-auth.session-token=rotated-session",
    )
    expect(conversation?.headers.get("chatgpt-account-id")).toBe("acct-web")
    expect(conversation?.headers.get("oai-device-id")).toBe(
      "device-from-server",
    )
    expect(recordUsage).toHaveBeenCalledTimes(1)
  })

  test("streams Claude Code style tool use", async () => {
    const backend = useWebBackend({
      conversation: () =>
        new Response(
          sseBody(
            assistantReplyEvents([
              "I'll read it.\n\n",
              '<tool_call>\n{"name": "Read", "arguments": {"file_path": "/etc/hostname"}}\n</tool_call>',
            ]),
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const response = await post("/chatgpt/v1/messages", {
      max_tokens: 1000,
      messages: [{ content: "Read /etc/hostname", role: "user" }],
      model: "gpt-6",
      stream: true,
      tools: [
        {
          description: "Reads a file from the local filesystem.",
          input_schema: {
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
            type: "object",
          },
          name: "Read",
        },
      ],
    })
    expect(response.status).toBe(200)
    const events = parseAnthropicSse(await response.text())
    const toolStart = events.find(
      (event) =>
        event.type === "content_block_start"
        && event.content_block.type === "tool_use",
    )
    expect(toolStart).toMatchObject({
      content_block: { name: "Read", type: "tool_use" },
    })
    const json = events
      .flatMap((event) =>
        (
          event.type === "content_block_delta"
          && event.delta.type === "input_json_delta"
        ) ?
          [event.delta.partial_json]
        : [],
      )
      .join("")
    expect(JSON.parse(json)).toEqual({ file_path: "/etc/hostname" })
    const text = events
      .flatMap((event) =>
        (
          event.type === "content_block_delta"
          && event.delta.type === "text_delta"
        ) ?
          [event.delta.text]
        : [],
      )
      .join("")
    expect(text).toBe("I'll read it.")
    expect(
      events.find((event) => event.type === "message_delta"),
    ).toMatchObject({
      delta: { stop_reason: "tool_use" },
    })
    expect(events.at(-1)?.type).toBe("message_stop")

    const sent = JSON.parse(backend.requests.at(-1)?.body ?? "{}") as {
      messages: Array<{ content: { parts: Array<string> } }>
    }
    expect(sent.messages[0]?.content.parts[0]).toContain('"name":"Read"')
  })

  test("returns a clear error for models the account does not offer", async () => {
    useWebBackend()
    const response = await post("/chatgpt/v1/messages", {
      max_tokens: 100,
      messages: [{ content: "hi", role: "user" }],
      model: "gpt-6.1-terra",
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain(
      "'chatgpt/gpt-6.1-terra' is not available in ChatGPT web",
    )
  })

  test("serves Chat Completions requests", async () => {
    useWebBackend()
    const response = await post("/chatgpt/v1/chat/completions", {
      messages: [{ content: "Say hello", role: "user" }],
      model: "gpt-6",
      stream: true,
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"content":"Hello"')
    expect(text).toContain('"usage":')
    expect(text.trim().endsWith("data: [DONE]")).toBe(true)
  })

  test("answers the Responses API through the Messages fallback", async () => {
    const handleCompletionPayload = mock(() =>
      Promise.resolve(
        Response.json({
          content: [{ text: "Hello from messages", type: "text" }],
          id: "msg_1",
          model: "chatgpt/gpt-6",
          role: "assistant",
          stop_reason: "end_turn",
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
      ),
    )
    responsesMessagesDependencies.handleCompletionPayload =
      handleCompletionPayload as unknown as typeof originalHandleCompletionPayload
    const response = await post("/chatgpt/v1/responses", {
      input: "Say hello",
      model: "gpt-6",
    })
    expect(response.status).toBe(200)
    expect(handleCompletionPayload).toHaveBeenCalledTimes(1)
    const [, messagesPayload] = handleCompletionPayload.mock
      .calls[0] as unknown as [unknown, { model: string }]
    expect(messagesPayload.model).toBe("chatgpt/gpt-6")
  })

  test("lists the web catalog for the chatgpt provider", async () => {
    useWebBackend()
    const response = await createApp().request("/chatgpt/v1/models")
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: Array<{ display_name: string; id: string }>
    }
    expect(body.data.map((model) => model.id)).toEqual([
      "gpt-6",
      "gpt-6-t-mini",
      "gpt-6-mini",
      "auto",
      "untitled",
    ])
    expect(body.data[0]?.display_name).toBe("GPT-6 Instant (chatgpt)")

    const records = await getProviderModelRecords(provider, new Headers())
    expect(records.map((model) => model.id)).toContain("gpt-6-t-mini")
    expect(records[1]).toMatchObject({ context_window: 262144 })
  })

  test("reports catalog failures", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ detail: "expired" }, { status: 401 }),
      )) as unknown as typeof fetch
    const response = await createApp().request("/chatgpt/v1/models")
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: "chatgpt_unauthorized" },
    })

    expect(await getProviderModelRecords(provider, new Headers())).toEqual([])
  })
})
