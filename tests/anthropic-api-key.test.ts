import { describe, expect, test } from "bun:test"

import {
  buildAnthropicProviderConfig,
  checkAnthropicApiKey,
} from "~/lib/providers/anthropic-api-key"
import { providerAuthRoutes } from "~/routes/auth/providers"

describe("Anthropic API key connection", () => {
  test("accepts an official API key and trims it", () => {
    expect(checkAnthropicApiKey("  sk-ant-api03-example  ")).toEqual({
      ok: true,
      apiKey: "sk-ant-api03-example",
    })
  })

  test("rejects subscription OAuth tokens with an explanation", () => {
    for (const token of ["sk-ant-oat01-example", "sk-ant-ort01-example"]) {
      const result = checkAnthropicApiKey(token)
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).toContain("Abo-Tokens")
      expect(JSON.stringify(result)).not.toContain(token)
    }
  })

  test("rejects other values", () => {
    const invalid = [
      undefined,
      42,
      "",
      "sk-other",
      `sk-ant-${"x".repeat(5000)}`,
    ]
    for (const value of invalid) {
      expect(checkAnthropicApiKey(value).ok).toBe(false)
    }
  })

  test("builds an anthropic provider and keeps admin model settings", () => {
    const config = buildAnthropicProviderConfig(
      { enabled: false, disabledModels: ["old-model"] },
      "sk-ant-api03-example",
    )
    expect(config).toEqual({
      enabled: true,
      disabledModels: ["old-model"],
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authType: "x-api-key",
      apiKey: "sk-ant-api03-example",
    })
  })

  test("requires a signed-in web user", async () => {
    const response = await providerAuthRoutes.request("/anthropic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-api03-example" }),
    })
    expect(response.status).toBe(401)
  })
})
