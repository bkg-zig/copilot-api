import { beforeEach, describe, expect, test } from "bun:test"

import { installModelsDevCatalog } from "~/lib/models-dev-cache"
import { resolveProviderConfigFromProvider } from "~/lib/provider-config"
import {
  isProviderModelVisible,
  matchesModelGlob,
} from "~/lib/provider-model-catalog"

import { modelsDevProviderCatalogFixture } from "./fixtures/models-dev-catalog"

beforeEach(() => installModelsDevCatalog(modelsDevProviderCatalogFixture))

describe("matchesModelGlob", () => {
  test("matches suffixes and prefixes", () => {
    expect(matchesModelGlob("*-free", "glm-5.3-flash-free")).toBe(true)
    expect(matchesModelGlob("*-free", "claude-opus-5")).toBe(false)
    expect(matchesModelGlob("claude-*", "claude-fable-5-2")).toBe(true)
    expect(matchesModelGlob("gpt-?", "gpt-5")).toBe(true)
    expect(matchesModelGlob("gpt-?", "gpt-55")).toBe(false)
  })

  test("treats regex metacharacters in the pattern literally", () => {
    expect(matchesModelGlob("a.b", "a.b")).toBe(true)
    expect(matchesModelGlob("a.b", "axb")).toBe(false)
    expect(matchesModelGlob("", "anything")).toBe(false)
  })
})

describe("isProviderModelVisible filters", () => {
  test("includeModels keeps only matching ids", () => {
    const config = {
      modelsDevProviderId: "opencode",
      includeModels: ["*-free"],
    }
    expect(isProviderModelVisible("oc", "glm-5.3-flash-free", config)).toBe(
      true,
    )
    expect(isProviderModelVisible("oc", "claude-opus-5", config)).toBe(false)
  })

  test("excludeModels hides matching ids", () => {
    const config = {
      modelsDevProviderId: "opencode",
      excludeModels: ["claude-*"],
    }
    expect(isProviderModelVisible("oc", "claude-opus-5", config)).toBe(false)
    expect(isProviderModelVisible("oc", "glm-5.3-flash-free", config)).toBe(
      true,
    )
  })

  test("excludeModels wins over includeModels", () => {
    const config = {
      modelsDevProviderId: "opencode",
      includeModels: ["*-free"],
      excludeModels: ["*flash-free"],
    }
    expect(isProviderModelVisible("oc", "glm-5.3-flash-free", config)).toBe(
      false,
    )
    expect(isProviderModelVisible("oc", "beam-free", config)).toBe(true)
  })

  test("lists everything when no filters are configured", () => {
    expect(isProviderModelVisible("oc", "claude-opus-5", {})).toBe(true)
    expect(
      isProviderModelVisible("oc", "claude-opus-5", {
        includeModels: [],
        excludeModels: [],
      }),
    ).toBe(true)
  })
})

describe("resolveProviderConfigFromProvider model filters", () => {
  test("copies includeModels and excludeModels onto the resolved config", () => {
    const resolved = resolveProviderConfigFromProvider("oc", {
      enabled: true,
      type: "openai-compatible",
      baseUrl: "https://opencode.ai/inference/openai/v1",
      apiKey: "oc_sk_test",
      includeModels: ["*-free"],
      excludeModels: ["beam-*"],
    })
    expect(resolved?.includeModels).toEqual(["*-free"])
    expect(resolved?.excludeModels).toEqual(["beam-*"])
  })
})
