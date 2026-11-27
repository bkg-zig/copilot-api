import { afterEach, describe, expect, test } from "bun:test"

import type { ResolvedProviderConfig } from "~/lib/types/config"
import { filterHealthyProviderModels } from "~/lib/providers/model-health"
import { normalizeProviderModel } from "~/routes/models/model-discovery"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function provider(name: string): ResolvedProviderConfig {
  return {
    name,
    type: "openai-compatible",
    baseUrl: "https://health-test.example/v1",
    apiKey: "health-test-key",
    authType: "authorization",
  }
}

describe("provider model health", () => {
  test("keeps every dynamically discovered bkg-api ID eligible for health filtering", () => {
    const normalized = normalizeProviderModel("bkg-api", {
      id: "future-model-from-api-global",
    })
    expect(normalized?.id).toBe("bkg-api/future-model-from-api-global")
  })

  test("does not probe or filter providers without admin-managed model settings", async () => {
    const models = [{ id: "kept-model" }]
    let requests = 0
    globalThis.fetch = (() => {
      requests += 1
      return Promise.resolve(
        Response.json({ choices: [{ message: { content: "OK" } }] }),
      )
    }) as unknown as typeof fetch

    const result = await filterHealthyProviderModels(
      provider("other-provider"),
      models,
    )

    expect(result).toBe(models)
    expect(requests).toBe(0)
  })

  test("health-filters custom providers once they are managed from the admin UI", async () => {
    const models = [{ id: "healthy" }, { id: "disabled" }]
    const managedProvider = {
      ...provider("custom-provider"),
      manualModels: ["manual"],
      disabledModels: ["disabled"],
    }
    globalThis.fetch = ((
      _input: Request | URL | string,
      init?: RequestInit,
    ) => {
      const payload = JSON.parse(init?.body as string) as { model: string }
      return Promise.resolve(
        Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: payload.model === "disabled" ? "" : "OK" },
            },
          ],
        }),
      )
    }) as unknown as typeof fetch

    const result = await filterHealthyProviderModels(managedProvider, models)

    expect(result.map((model) => model.id).sort()).toEqual([
      "healthy",
      "manual",
    ])
  })

  test("probes chat models with a non-streaming completion", async () => {
    globalThis.fetch = ((
      _input: Request | URL | string,
      init?: RequestInit,
    ) => {
      const payload = JSON.parse(init?.body as string) as {
        model: string
        stream: boolean
      }
      expect(payload.stream).toBe(false)
      if (payload.model === "truncated") {
        return Promise.resolve(
          Response.json({
            choices: [
              { finish_reason: "length", message: { content: "partial" } },
            ],
          }),
        )
      }
      return Promise.resolve(
        Response.json({
          choices: [{ finish_reason: "stop", message: { content: "OK" } }],
        }),
      )
    }) as unknown as typeof fetch

    const result = await filterHealthyProviderModels(provider("bkg-api"), [
      { id: "complete" },
      { id: "truncated" },
    ])
    expect(result.map((model) => model.id)).toEqual(["complete"])
  })

  test("publishes only discovered models with a non-empty, complete completion", async () => {
    globalThis.fetch = ((
      _input: Request | URL | string,
      init?: RequestInit,
    ) => {
      const payload = JSON.parse(init?.body as string) as { model: string }
      switch (payload.model) {
        case "healthy":
          return Promise.resolve(
            Response.json({
              choices: [{ finish_reason: "stop", message: { content: "OK" } }],
            }),
          )
        case "upstream-error":
          return Promise.resolve(
            Response.json(
              { error: { message: "unavailable" } },
              { status: 503 },
            ),
          )
        case "empty":
          return Promise.resolve(
            Response.json({
              choices: [{ finish_reason: "stop", message: { content: "" } }],
            }),
          )
        case "truncated":
          return Promise.resolve(
            Response.json({
              choices: [{ finish_reason: "length", message: { content: "" } }],
            }),
          )
        default:
          return Promise.resolve(Response.json({ choices: [] }))
      }
    }) as unknown as typeof fetch

    const models = [
      { id: "healthy" },
      { id: "upstream-error" },
      { id: "empty" },
      { id: "truncated" },
    ]
    const result = await filterHealthyProviderModels(
      provider("bkg-api"),
      models,
    )

    expect(result.map((model) => model.id)).toEqual(["healthy"])
  })
})
