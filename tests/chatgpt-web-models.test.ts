import { afterEach, describe, expect, test } from "bun:test"

import {
  clearChatGPTWebCatalogCache,
  getChatGPTWebModels,
  loadChatGPTWebCatalog,
  parseChatGPTWebCatalog,
  requireChatGPTWebModel,
  toChatGPTWebGatewayModel,
} from "~/services/chatgpt/models"
import { resolveChatGPTWebSession } from "~/services/chatgpt/web-client"

import {
  type FetchInput,
  rejectionOf,
  requestUrlOf,
  webCatalogFixture,
} from "./fixtures/chatgpt-web"

function jsonFetch(body: unknown, calls: Array<string> = [], status = 200) {
  return ((input: FetchInput) => {
    calls.push(requestUrlOf(input))
    return Promise.resolve(Response.json(body, { status }))
  }) as typeof fetch
}

const providerConfig = { apiKey: "token", baseUrl: "https://chatgpt.example" }

afterEach(() => {
  clearChatGPTWebCatalogCache()
})

describe("chatgpt web models", () => {
  test("parses the catalog without hidden and research models", () => {
    expect(parseChatGPTWebCatalog(webCatalogFixture)).toEqual({
      defaultSlug: "auto",
      models: [
        {
          contextWindow: 34834,
          displayName: "GPT-6 Instant",
          reasoning: false,
          slug: "gpt-6",
        },
        {
          contextWindow: 262144,
          displayName: "GPT-6 Thinking mini",
          reasoning: true,
          slug: "gpt-6-t-mini",
        },
        {
          contextWindow: 34834,
          displayName: "GPT-6 [gpt-6-mini]",
          reasoning: false,
          slug: "gpt-6-mini",
        },
        {
          contextWindow: 34834,
          displayName: "Auto",
          reasoning: false,
          slug: "auto",
        },
        {
          contextWindow: undefined,
          displayName: "untitled",
          reasoning: false,
          slug: "untitled",
        },
      ],
    })
    expect(
      parseChatGPTWebCatalog({ default_model_slug: "research", models: [] })
        .defaultSlug,
    ).toBeUndefined()
    expect(() => parseChatGPTWebCatalog({ models: "x" })).toThrow(
      "unexpected model catalog",
    )
  })

  test("converts catalog entries into gateway models", () => {
    expect(
      toChatGPTWebGatewayModel({
        contextWindow: 262144,
        displayName: "GPT-6 Thinking mini",
        reasoning: true,
        slug: "gpt-6-t-mini",
      }),
    ).toMatchObject({
      capabilities: {
        limits: {
          max_context_window_tokens: 262144,
          max_output_tokens: 16384,
          max_prompt_tokens: 262144,
        },
        supports: { tool_calls: true, vision: false },
      },
      id: "gpt-6-t-mini",
      name: "GPT-6 Thinking mini",
      version: "chatgpt-web",
    })
    expect(
      toChatGPTWebGatewayModel({
        displayName: "x",
        reasoning: false,
        slug: "x",
      }).capabilities.limits.max_output_tokens,
    ).toBe(16384)
    expect(
      toChatGPTWebGatewayModel({
        contextWindow: 1000,
        displayName: "small",
        reasoning: false,
        slug: "small",
      }).capabilities.limits.max_output_tokens,
    ).toBe(1000)
  })

  test("caches the catalog per account and refreshes after expiry", async () => {
    const calls: Array<string> = []
    const fetchImpl = jsonFetch(webCatalogFixture, calls)
    const session = await resolveChatGPTWebSession(providerConfig)
    let now = 1_000
    const options = { fetch: fetchImpl, now: () => now }

    const [first, second] = await Promise.all([
      loadChatGPTWebCatalog(session, options),
      loadChatGPTWebCatalog(session, options),
    ])
    expect(second).toBe(first)
    expect(calls).toEqual(["https://chatgpt.example/backend-api/models"])

    await loadChatGPTWebCatalog(session, options)
    expect(calls).toHaveLength(1)

    now += 11 * 60 * 1000
    await loadChatGPTWebCatalog(session, options)
    expect(calls).toHaveLength(2)

    await loadChatGPTWebCatalog(session, { ...options, forceRefresh: true })
    expect(calls).toHaveLength(3)
  })

  test("bounds the number of cached accounts", async () => {
    const calls: Array<string> = []
    const fetchImpl = jsonFetch(webCatalogFixture, calls)
    for (let index = 0; index < 17; index++) {
      await loadChatGPTWebCatalog(
        await resolveChatGPTWebSession({
          apiKey: "token",
          baseUrl: `https://chatgpt-${index}.example`,
        }),
        { fetch: fetchImpl },
      )
    }
    await loadChatGPTWebCatalog(
      await resolveChatGPTWebSession({
        apiKey: "token",
        baseUrl: "https://chatgpt-0.example",
      }),
      { fetch: fetchImpl },
    )
    expect(calls).toHaveLength(18)
  })

  test("returns gateway models and validates requested slugs", async () => {
    const fetchImpl = jsonFetch(webCatalogFixture)
    const models = await getChatGPTWebModels(providerConfig, {
      fetch: fetchImpl,
    })
    expect(models.map((model) => model.id)).toEqual([
      "gpt-6",
      "gpt-6-t-mini",
      "gpt-6-mini",
      "auto",
      "untitled",
    ])

    const session = await resolveChatGPTWebSession(providerConfig)
    expect(
      (
        await requireChatGPTWebModel(session, "gpt-6-t-mini", {
          fetch: fetchImpl,
        })
      ).slug,
    ).toBe("gpt-6-t-mini")
    const missing = await rejectionOf(
      requireChatGPTWebModel(session, "gpt-6.1-terra", { fetch: fetchImpl }),
    )
    expect(missing).toMatchObject({ code: "model_not_found", status: 400 })
    expect((missing as Error).message).toContain(
      "'chatgpt/gpt-6.1-terra' is not available in ChatGPT web for this account. Available: chatgpt/gpt-6, chatgpt/gpt-6-t-mini",
    )
  })

  test("reports an empty catalog and upstream failures", async () => {
    const session = await resolveChatGPTWebSession(providerConfig)
    const empty = await rejectionOf(
      requireChatGPTWebModel(session, "gpt-6", {
        fetch: jsonFetch({ models: [] }),
      }),
    )
    expect((empty as Error).message).toEndWith("Available: none.")

    clearChatGPTWebCatalogCache()
    expect(
      await rejectionOf(
        loadChatGPTWebCatalog(session, {
          fetch: jsonFetch({ detail: "expired" }, [], 401),
        }),
      ),
    ).toMatchObject({ code: "chatgpt_unauthorized", status: 401 })
  })
})
