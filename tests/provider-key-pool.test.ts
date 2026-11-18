import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { getAdminProviders, upsertAdminProvider } from "~/lib/admin-config"
import type { ProviderConfig, ResolvedProviderConfig } from "~/lib/config"
import { invalidateConfigCache, type AppConfig } from "~/lib/config-store"
import { PATHS } from "~/lib/paths"
import {
  resolveProviderApiKeyPool,
  resolveProviderConfigFromProvider,
} from "~/lib/provider-config"
import {
  PROVIDER_KEY_AUTH_FAILURE_COOLDOWN_MS,
  PROVIDER_KEY_RATE_LIMIT_COOLDOWN_MS,
  PROVIDER_KEY_RPM_WINDOW_MS,
  noteProviderApiKeyResult,
  resetProviderApiKeyPools,
  selectProviderApiKey,
} from "~/lib/provider-key-pool"
import {
  buildProviderUpstreamHeaders,
  forwardProviderMessages,
  selectProviderRequestApiKey,
} from "~/services/providers/provider-proxy"

const KEY_A = "nvapi-aaaa"
const KEY_B = "nvapi-bbbb"
const KEY_C = "nvapi-cccc"

const originalConfigPath = PATHS.CONFIG_PATH
let tempDir: string | undefined

beforeEach(() => resetProviderApiKeyPools())

afterEach(() => {
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

function withConfig(config: AppConfig): void {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-keypool-"))
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  fs.writeFileSync(PATHS.CONFIG_PATH, JSON.stringify(config), "utf8")
  invalidateConfigCache()
}

const baseProvider = {
  type: "openai-compatible",
  baseUrl: "https://integrate.api.nvidia.com",
} as const

function providerConfig(
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig {
  return {
    name: "nv",
    type: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com",
    apiKey: KEY_A,
    authType: "authorization",
    ...overrides,
  }
}

describe("resolveProviderApiKeyPool", () => {
  test("falls back to the single apiKey shorthand", () => {
    const provider: ProviderConfig = { apiKey: KEY_A }
    expect(resolveProviderApiKeyPool(provider)).toEqual([{ key: KEY_A }])
  })

  test("returns an empty pool when no key is configured", () => {
    expect(resolveProviderApiKeyPool({})).toEqual([])
    expect(resolveProviderApiKeyPool({ apiKey: "   " })).toEqual([])
  })

  test("keeps enabled keys, drops disabled ones and deduplicates", () => {
    const provider: ProviderConfig = {
      apiKeys: [
        { key: KEY_A },
        { key: KEY_B, enabled: false },
        { key: KEY_C, rpm: 40, owner: "eysho" },
        { key: KEY_A },
        { key: "  " },
      ],
      apiKey: "nvapi-dddd",
    }
    expect(resolveProviderApiKeyPool(provider)).toEqual([
      { key: KEY_A },
      { key: KEY_C, rpm: 40 },
      { key: "nvapi-dddd" },
    ])
  })

  test("ignores non-positive and non-numeric rpm values", () => {
    const provider: ProviderConfig = {
      apiKeys: [
        { key: KEY_A, rpm: 0 },
        { key: KEY_B, rpm: -5 },
        { key: KEY_C, rpm: 12.9 },
      ],
    }
    expect(resolveProviderApiKeyPool(provider)).toEqual([
      { key: KEY_A },
      { key: KEY_B },
      { key: KEY_C, rpm: 12 },
    ])
  })
})

describe("selectProviderApiKey", () => {
  test("returns the only key unchanged", () => {
    expect(selectProviderApiKey("nv", [{ key: KEY_A }])).toBe(KEY_A)
  })

  test("returns undefined for an empty pool", () => {
    expect(selectProviderApiKey("nv", [])).toBeUndefined()
  })

  test("rotates round-robin across the pool", () => {
    const keys = [{ key: KEY_A }, { key: KEY_B }, { key: KEY_C }]
    const picked = Array.from({ length: 4 }, () =>
      selectProviderApiKey("nv", keys),
    )
    expect(picked).toEqual([KEY_A, KEY_B, KEY_C, KEY_A])
  })

  test("skips a key that was rate limited", () => {
    const keys = [{ key: KEY_A }, { key: KEY_B }]
    const now = 1_000_000
    noteProviderApiKeyResult("nv", KEY_A, 429, now)
    expect(selectProviderApiKey("nv", keys, now)).toBe(KEY_B)
  })

  test("uses a rate-limited key again once the cooldown expires", () => {
    const keys = [{ key: KEY_A }, { key: KEY_B }]
    const now = 1_000_000
    noteProviderApiKeyResult("nv", KEY_A, 429, now)
    expect(selectProviderApiKey("nv", keys, now)).toBe(KEY_B)
    expect(
      selectProviderApiKey(
        "nv",
        keys,
        now + PROVIDER_KEY_RATE_LIMIT_COOLDOWN_MS + 1,
      ),
    ).toBe(KEY_A)
  })

  test("falls back to a cooling key when every key is throttled", () => {
    const keys = [{ key: KEY_A }, { key: KEY_B }]
    const now = 1_000_000
    noteProviderApiKeyResult("nv", KEY_A, 429, now)
    noteProviderApiKeyResult("nv", KEY_B, 401, now)
    // Both are cooling down, so a request is still attempted rather than
    // failing locally.
    expect(selectProviderApiKey("nv", keys, now)).toBe(KEY_A)
  })

  test("honors the per-key rpm budget within the window", () => {
    const keys = [
      { key: KEY_A, rpm: 1 },
      { key: KEY_B, rpm: 1 },
    ]
    const now = 1_000_000
    expect(selectProviderApiKey("nv", keys, now)).toBe(KEY_A)
    expect(selectProviderApiKey("nv", keys, now)).toBe(KEY_B)
    // Both budgets are exhausted in the same window; the request still runs.
    expect(selectProviderApiKey("nv", keys, now)).toBe(KEY_A)
  })

  test("resets the rpm budget after the window elapses", () => {
    const keys = [
      { key: KEY_A, rpm: 1 },
      { key: KEY_B, rpm: 1 },
    ]
    const now = 1_000_000
    selectProviderApiKey("nv", keys, now)
    selectProviderApiKey("nv", keys, now)
    expect(
      selectProviderApiKey("nv", keys, now + PROVIDER_KEY_RPM_WINDOW_MS + 1),
    ).toBe(KEY_A)
  })

  test("clears the cooldown after a successful response", () => {
    const keys = [{ key: KEY_A }, { key: KEY_B }]
    const now = 1_000_000
    noteProviderApiKeyResult("nv", KEY_A, 429, now)
    noteProviderApiKeyResult("nv", KEY_A, 200, now)
    expect(selectProviderApiKey("nv", keys, now)).toBe(KEY_A)
  })

  test("applies a longer cooldown after an auth failure", () => {
    const keys = [{ key: KEY_A }, { key: KEY_B }]
    const now = 1_000_000
    noteProviderApiKeyResult("nv", KEY_A, 403, now)
    expect(selectProviderApiKey("nv", keys, now)).toBe(KEY_B)
    expect(
      selectProviderApiKey(
        "nv",
        keys,
        now + PROVIDER_KEY_RATE_LIMIT_COOLDOWN_MS,
      ),
    ).toBe(KEY_B)
    expect(
      selectProviderApiKey(
        "nv",
        keys,
        now + PROVIDER_KEY_AUTH_FAILURE_COOLDOWN_MS + 1,
      ),
    ).toBe(KEY_A)
  })

  test("keeps separate rotation state per provider", () => {
    const keys = [{ key: KEY_A }, { key: KEY_B }]
    expect(selectProviderApiKey("nv", keys)).toBe(KEY_A)
    expect(selectProviderApiKey("other", keys)).toBe(KEY_A)
  })
})

describe("resolveProviderConfigFromProvider key pool", () => {
  test("keeps single-key providers backward compatible", () => {
    const resolved = resolveProviderConfigFromProvider("nv", {
      ...baseProvider,
      apiKey: KEY_A,
    })
    expect(resolved?.apiKey).toBe(KEY_A)
    expect(resolved?.keyPool).toBeUndefined()
  })

  test("exposes the enabled pool and mirrors the first key as apiKey", () => {
    const resolved = resolveProviderConfigFromProvider("nv", {
      ...baseProvider,
      apiKeys: [
        { key: KEY_A },
        { key: KEY_B, enabled: false },
        { key: KEY_C, rpm: 40 },
      ],
    })
    expect(resolved?.apiKey).toBe(KEY_A)
    expect(resolved?.keyPool).toEqual([{ key: KEY_A }, { key: KEY_C, rpm: 40 }])
  })

  test("treats a provider with only disabled keys as missing an apiKey", () => {
    expect(
      resolveProviderConfigFromProvider("nv", {
        ...baseProvider,
        apiKeys: [{ key: KEY_A, enabled: false }],
      }),
    ).toBeNull()
  })

  test("returns null for a disabled provider", () => {
    expect(
      resolveProviderConfigFromProvider("nv", {
        ...baseProvider,
        enabled: false,
        apiKey: KEY_A,
      }),
    ).toBeNull()
  })
})

describe("admin provider apiKeys", () => {
  test("round-trips a key pool through the admin upsert", () => {
    withConfig({ providers: {} })
    const providers = upsertAdminProvider({
      name: "nv",
      ...baseProvider,
      apiKeys: [
        { key: KEY_A, rpm: 40, owner: "eysho" },
        { key: KEY_B, enabled: false },
      ],
    })
    const view = providers.find((provider) => provider.name === "nv")
    expect(view?.apiKeys).toEqual([
      { key: KEY_A, enabled: true, rpm: 40, owner: "eysho" },
      { key: KEY_B, enabled: false, rpm: null, owner: "" },
    ])
    expect(view?.hasApiKey).toBe(true)

    const onDisk = JSON.parse(
      fs.readFileSync(PATHS.CONFIG_PATH, "utf8"),
    ) as AppConfig
    expect(onDisk.providers?.nv?.apiKeys).toEqual([
      { key: KEY_A, rpm: 40, owner: "eysho" },
      { key: KEY_B, enabled: false },
    ])
  })

  test("an empty apiKeys array removes the pool", () => {
    withConfig({
      providers: { nv: { ...baseProvider, apiKeys: [{ key: KEY_A }] } },
    })
    const providers = upsertAdminProvider({ name: "nv", apiKeys: [] })
    expect(
      providers.find((provider) => provider.name === "nv")?.apiKeys,
    ).toEqual([])
  })

  test("preserves an existing pool when the form omits apiKeys", () => {
    withConfig({
      providers: { nv: { ...baseProvider, apiKeys: [{ key: KEY_A }] } },
    })
    upsertAdminProvider({ name: "nv", apiKey: KEY_B })
    const onDisk = getAdminProviders().find(
      (provider) => provider.name === "nv",
    )
    expect(onDisk?.apiKeys).toEqual([
      { key: KEY_A, enabled: true, rpm: null, owner: "" },
    ])
    expect(onDisk?.apiKey).toBe(KEY_B)
  })
})

describe("selectProviderRequestApiKey", () => {
  test("uses apiKey when no pool is present", () => {
    expect(selectProviderRequestApiKey(providerConfig())).toEqual({
      apiKey: KEY_A,
    })
  })

  test("rotates through the pool and returns the chosen key", () => {
    const config = providerConfig({
      keyPool: [{ key: KEY_A }, { key: KEY_B }],
    })
    expect(selectProviderRequestApiKey(config)).toEqual({
      apiKey: KEY_A,
      key: KEY_A,
    })
    expect(selectProviderRequestApiKey(config)).toEqual({
      apiKey: KEY_B,
      key: KEY_B,
    })
  })
})

describe("buildProviderUpstreamHeaders", () => {
  test("uses the selected key for the authorization header", () => {
    const headers = buildProviderUpstreamHeaders(
      providerConfig({ keyPool: [{ key: KEY_A }, { key: KEY_B }] }),
      new Headers(),
      KEY_B,
    )
    expect(headers.authorization).toBe(`Bearer ${KEY_B}`)
  })

  test("defaults to the provider apiKey", () => {
    const headers = buildProviderUpstreamHeaders(
      providerConfig(),
      new Headers(),
    )
    expect(headers.authorization).toBe(`Bearer ${KEY_A}`)
  })

  test("supports x-api-key auth types", () => {
    const headers = buildProviderUpstreamHeaders(
      providerConfig({ authType: "x-api-key" }),
      new Headers(),
      KEY_C,
    )
    expect(headers["x-api-key"]).toBe(KEY_C)
    expect(headers.authorization).toBeUndefined()
  })
})

describe("forwardProviderMessages key rotation", () => {
  const originalFetch = globalThis.fetch
  const payload = { model: "m", messages: [], max_tokens: 1 }

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockUpstream(statuses: Array<number>): Array<string | undefined> {
    const seen: Array<string | undefined> = []
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? undefined)
      const status = statuses[seen.length - 1] ?? 200
      return Promise.resolve(
        new Response("{}", {
          status,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as typeof fetch
    return seen
  }

  test("retries with the next key after a 429", async () => {
    const seen = mockUpstream([429, 200])
    const config = providerConfig({ keyPool: [{ key: KEY_A }, { key: KEY_B }] })
    const response = await forwardProviderMessages(
      config,
      payload,
      new Headers(),
    )
    expect(response.status).toBe(200)
    expect(seen).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`])
  })

  test("does not retry on a non-429 error", async () => {
    const seen = mockUpstream([500])
    const config = providerConfig({ keyPool: [{ key: KEY_A }, { key: KEY_B }] })
    const response = await forwardProviderMessages(
      config,
      payload,
      new Headers(),
    )
    expect(response.status).toBe(500)
    expect(seen).toEqual([`Bearer ${KEY_A}`])
  })
})
