import { describe, expect, test } from "bun:test"

import {
  normalizeProviderBaseUrl,
  resolveProviderAuthType,
  type ResolvedProviderConfig,
} from "~/lib/config"

import {
  buildProviderUpstreamHeaders,
  resolveProviderEndpointUrl,
} from "~/services/providers/provider-proxy"

function createProviderConfig(
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig {
  return {
    name: "custom",
    type: "anthropic",
    baseUrl: "https://example.com",
    apiKey: "provider-key",
    authType: "x-api-key",
    ...overrides,
  }
}

describe("buildProviderUpstreamHeaders", () => {
  test("uses x-api-key auth by default", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig(),
      new Headers({
        accept: "application/json",
        "anthropic-version": "2023-06-01",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": "provider-key",
      "anthropic-version": "2023-06-01",
    })
  })

  test("uses Authorization bearer auth when configured", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({ authType: "authorization" }),
      new Headers({
        accept: "application/json",
        "user-agent": "test-client",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
      "user-agent": "test-client",
    })
  })

  test("does not forward Anthropic-only headers to OpenAI-compatible providers", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({
        authType: "authorization",
        type: "openai-compatible",
      }),
      new Headers({
        accept: "application/json",
        "anthropic-version": "2023-06-01",
      }),
    )

    expect(headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })
  })

  test("sets an Anthropic API version for a selected models.dev provider", () => {
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({ modelsDevProviderId: "anthropic-provider" }),
      new Headers(),
    )
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers["x-api-key"]).toBe("provider-key")
  })
})

describe("resolveProviderAuthType", () => {
  test("supports OAuth bearer auth for xAI", () => {
    expect(resolveProviderAuthType("xai", "oauth2", "openai-responses")).toBe(
      "oauth2",
    )
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({
        name: "xai",
        type: "openai-responses",
        authType: "oauth2",
        apiKey: "xai-access-token",
      }),
      new Headers({
        authorization: "Bearer client-token",
        "x-api-key": "client-key",
      }),
    )
    expect(headers.authorization).toBe("Bearer xai-access-token")
    expect(headers["x-api-key"]).toBeUndefined()
  })
  test("supports explicit no-auth upstreams without forwarding credentials", () => {
    expect(resolveProviderAuthType("bridge", "none", "openai-compatible")).toBe(
      "none",
    )
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({ authType: "none", apiKey: "" }),
      new Headers({
        authorization: "Bearer client-secret",
        "x-api-key": "client-secret",
      }),
    )
    expect(headers.authorization).toBeUndefined()
    expect(headers["x-api-key"]).toBeUndefined()
    expect(headers["content-type"]).toBe("application/json")
  })

  test("falls back to OpenAI-compatible default for invalid authType", () => {
    expect(
      resolveProviderAuthType("dash", "invalid-auth-type", "openai-compatible"),
    ).toBe("authorization")
  })

  test("falls back to Anthropic default for invalid authType", () => {
    expect(
      resolveProviderAuthType("custom", "invalid-auth-type", "anthropic"),
    ).toBe("x-api-key")
  })

  test("supports Claude subscription OAuth headers", () => {
    expect(resolveProviderAuthType("anthropic", "oauth2", "anthropic")).toBe(
      "oauth2",
    )
    const headers = buildProviderUpstreamHeaders(
      createProviderConfig({
        name: "anthropic",
        type: "anthropic",
        authType: "oauth2",
        apiKey: "claude-access-token",
      }),
      new Headers({ "anthropic-beta": "context-1m-2025-08-07" }),
    )
    expect(headers.authorization).toBe("Bearer claude-access-token")
    expect(headers["anthropic-beta"]?.startsWith("oauth-2025-04-20")).toBe(true)
    expect(headers["anthropic-beta"]).toContain("claude-code-20250219")
    expect(headers["anthropic-beta"]).toContain("context-1m-2025-08-07")
    expect(headers["x-app"]).toBe("cli")
  })

  test("falls back for non-codex oauth2 providers", () => {
    expect(
      resolveProviderAuthType("custom", "oauth2", "openai-responses"),
    ).toBe("authorization")
  })
})

describe("provider endpoint URL", () => {
  test.each([
    ["https://opencode.ai/zen/go", "https://opencode.ai/inference/go"],
    [" https://opencode.ai/zen/go/v1/ ", "https://opencode.ai/inference/go/v1"],
    ["https://opencode.ai/zen", "https://opencode.ai/zen"],
    ["https://opencode.ai/zen/gopher", "https://opencode.ai/zen/gopher"],
    ["https://proxy.example/zen/go", "https://proxy.example/zen/go"],
  ])("normalizes the legacy Go base URL %s", (baseUrl, expected) => {
    expect(normalizeProviderBaseUrl(baseUrl)).toBe(expected)
  })

  test.each([
    { type: "anthropic", endpoint: "messages" },
    { type: "openai-compatible", endpoint: "chat/completions" },
    { type: "openai-responses", endpoint: "responses" },
    { type: "google", endpoint: "models/gemini-test:generateContent" },
    { type: "google", endpoint: "models/gemini-test:streamGenerateContent" },
  ] as const)(
    "migrates Go $type requests without duplicating v1",
    ({ type, endpoint }) => {
      for (const baseUrl of [
        "https://opencode.ai/zen/go",
        "https://opencode.ai/zen/go/v1/",
        "https://opencode.ai/inference/go",
        "https://opencode.ai/inference/go/v1",
      ]) {
        expect(
          resolveProviderEndpointUrl(
            createProviderConfig({ name: "opencode-go", type, baseUrl }),
            endpoint,
          ),
        ).toBe(`https://opencode.ai/inference/go/v1/${endpoint}`)
      }
    },
  )

  test("uses models.dev API paths directly for all three supported protocols", () => {
    const provider = createProviderConfig({
      baseUrl: "https://api.example.com/anthropic/v1",
      modelsDevProviderId: "example",
    })
    expect(resolveProviderEndpointUrl(provider, "messages")).toBe(
      "https://api.example.com/anthropic/v1/messages",
    )
    expect(resolveProviderEndpointUrl(provider, "chat/completions")).toBe(
      "https://api.example.com/anthropic/v1/chat/completions",
    )
    expect(resolveProviderEndpointUrl(provider, "responses")).toBe(
      "https://api.example.com/anthropic/v1/responses",
    )
  })

  test("does not duplicate a catalog URL's final chat endpoint", () => {
    expect(
      resolveProviderEndpointUrl(
        createProviderConfig({
          baseUrl: "https://api.example.com/v1/chat/completions",
          modelsDevProviderId: "example",
        }),
        "chat/completions",
      ),
    ).toBe("https://api.example.com/v1/chat/completions")
  })

  test.each([
    [
      "https://text.pollinations.ai/openai",
      "https://text.pollinations.ai/openai/chat/completions",
    ],
    [
      "https://api.kilo.ai/api/gateway",
      "https://api.kilo.ai/api/gateway/chat/completions",
    ],
    [
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    ],
  ])("preserves OpenAI-compatible base path %s", (baseUrl, expected) => {
    expect(
      resolveProviderEndpointUrl(
        createProviderConfig({ baseUrl }),
        "chat/completions",
      ),
    ).toBe(expected)
  })

  test("preserves the existing manual-provider URL convention", () => {
    expect(
      resolveProviderEndpointUrl(
        createProviderConfig({ baseUrl: "https://api.example.com/api" }),
        "chat/completions",
      ),
    ).toBe("https://api.example.com/api/v1/chat/completions")
  })
})
