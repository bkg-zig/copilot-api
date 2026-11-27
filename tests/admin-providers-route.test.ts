import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"

import {
  invalidateConfigCache,
  writeConfigToDisk,
  type AppConfig,
} from "~/lib/config/config-store"
import { PATHS } from "~/lib/storage/paths"
import {
  providerAdminRoutes,
  resetFreeProviderCatalogCache,
} from "~/routes/admin/config/providers"

const originalConfigPath = PATHS.CONFIG_PATH
const originalFetch = globalThis.fetch
let tempDir: string | undefined
let failingModelIds = new Set<string>()

function fixture(): AppConfig {
  return {
    auth: {
      adminApiKey: "admin-secret",
      apiKeyConfigs: [],
    },
    providers: {
      "github-copilot": { enabled: false },
    },
    modelMappings: {},
  }
}

function createApp() {
  const app = new Hono()
  app.route("/admin/config/providers", providerAdminRoutes)
  return app
}

function requestBody(body: unknown, method = "POST") {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-admin-providers-"))
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  writeConfigToDisk(fixture())
  invalidateConfigCache()
  failingModelIds = new Set()
  resetFreeProviderCatalogCache()

  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input
      : input instanceof URL ? input.toString()
      : input.url,
    )
    if (url.pathname.endsWith("/v1/models")) {
      return Promise.resolve(
        Response.json({
          object: "list",
          data: [{ id: "discovered-model" }],
          has_more: false,
        }),
      )
    }
    if (url.pathname.endsWith("/v1/chat/completions")) {
      const body = JSON.parse(init?.body as string) as { model: string }
      const content = failingModelIds.has(body.model) ? "" : "OK"
      return Promise.resolve(
        Response.json({
          choices: [{ finish_reason: "stop", message: { content } }],
        }),
      )
    }
    return Promise.resolve(
      Response.json(
        { error: { message: "Unexpected test URL" } },
        { status: 404 },
      ),
    )
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
  resetFreeProviderCatalogCache()
})

test("provider summaries never return configured API keys", async () => {
  const config = fixture()
  config.providers = {
    ...config.providers,
    "my-provider": {
      type: "openai-compatible",
      baseUrl: "https://provider.example",
      authType: "authorization",
      apiKey: "provider-secret",
      enabled: true,
    },
  }
  writeConfigToDisk(config)
  invalidateConfigCache()

  const response = await createApp().request("/admin/config/providers")
  const text = await response.text()

  expect(response.status).toBe(200)
  expect(text).toContain('"hasApiKey":true')
  expect(text).not.toContain("provider-secret")
})

test("creates a custom provider and returns only a credential-presence flag", async () => {
  const response = await createApp().request(
    "/admin/config/providers",
    requestBody({
      name: "my-provider",
      type: "openai-compatible",
      baseUrl: "https://provider.example",
      authType: "authorization",
      apiKey: "provider-secret",
      enabled: true,
    }),
  )
  const result = (await response.json()) as {
    provider: { name: string; hasApiKey: boolean }
  }

  expect(response.status).toBe(201)
  const config = JSON.parse(
    fs.readFileSync(PATHS.CONFIG_PATH, "utf8"),
  ) as AppConfig
  expect(config.providers?.["my-provider"]?.apiKey).toBe("provider-secret")
  expect(config.providers?.["my-provider"]?.baseUrl).toBe(
    "https://provider.example",
  )
  expect(result.provider.name).toBe("my-provider")
  expect(result.provider.hasApiKey).toBe(true)
  expect(JSON.stringify(result)).not.toContain("provider-secret")
})

test("does not allow system-managed provider names to be created", async () => {
  const response = await createApp().request(
    "/admin/config/providers",
    requestBody({
      name: "bkg-api",
      type: "openai-compatible",
      baseUrl: "https://other.example",
      apiKey: "do-not-store",
    }),
  )

  expect(response.status).toBe(400)
  const config = JSON.parse(
    fs.readFileSync(PATHS.CONFIG_PATH, "utf8"),
  ) as AppConfig
  expect(config.providers?.["bkg-api"]).toBeUndefined()
})

test("does not allow system-managed providers to be edited or deleted", async () => {
  const config = fixture()
  config.providers = {
    ...config.providers,
    "bkg-api": {
      type: "openai-compatible",
      baseUrl: "https://api.eysho.info",
      apiKey: "system-secret",
      enabled: true,
    },
  }
  writeConfigToDisk(config)
  invalidateConfigCache()

  const update = await createApp().request(
    "/admin/config/providers/bkg-api",
    requestBody({ enabled: false }, "PATCH"),
  )
  const remove = await createApp().request("/admin/config/providers/bkg-api", {
    method: "DELETE",
  })

  expect(update.status).toBe(403)
  expect(remove.status).toBe(403)
  const stored = JSON.parse(
    fs.readFileSync(PATHS.CONFIG_PATH, "utf8"),
  ) as AppConfig
  expect(stored.providers?.["bkg-api"]?.enabled).toBe(true)
})

test("creates a keyless provider when authType is none", async () => {
  const response = await createApp().request(
    "/admin/config/providers",
    requestBody({
      name: "anonymous-bridge",
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:4981",
      authType: "none",
      enabled: true,
    }),
  )
  expect(response.status).toBe(201)
  const config = JSON.parse(
    fs.readFileSync(PATHS.CONFIG_PATH, "utf8"),
  ) as AppConfig
  expect(config.providers?.["anonymous-bridge"]?.apiKey).toBeUndefined()
  expect(config.providers?.["anonymous-bridge"]?.authType).toBe("none")
})

test("rejects free catalogue records that are not OpenAI compatible", async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        generated: "2026-11-22",
        site: "https://catalog.example",
        entries: [
          {
            id: "valid",
            name: "Valid",
            category: "api-free-tier",
            api: {
              openai_compatible: true,
              base_url: "https://provider.example/v1",
              auth: "none",
              model_ids: ["model-a"],
            },
          },
          {
            id: "archived",
            name: "Archived",
            archived: true,
            api: {
              openai_compatible: true,
              base_url: "https://old.example/v1",
            },
          },
          {
            id: "not-openai",
            name: "Not OpenAI",
            api: {
              openai_compatible: false,
              base_url: "https://native.example",
            },
          },
        ],
      }),
    )) as unknown as typeof fetch
  const response = await createApp().request(
    "/admin/config/providers/catalog/free",
  )
  const result = (await response.json()) as {
    providers: Array<{ id: string; authType: string }>
  }
  expect(response.status).toBe(200)
  expect(result.providers.map((provider) => provider.id)).toEqual(["valid"])
  expect(result.providers[0]?.authType).toBe("none")
})

test("manual models are only persisted after a successful completion test", async () => {
  const config = fixture()
  config.providers = {
    ...config.providers,
    "my-provider": {
      type: "openai-compatible",
      baseUrl: "https://provider.example",
      apiKey: "provider-secret",
      enabled: true,
      manualModels: [],
      disabledModels: [],
    },
  }
  writeConfigToDisk(config)
  invalidateConfigCache()
  failingModelIds.add("broken-model")

  const failed = await createApp().request(
    "/admin/config/providers/my-provider/models/manual",
    requestBody({ modelId: "broken-model" }),
  )

  expect(failed.status).toBe(422)
  let stored = JSON.parse(
    fs.readFileSync(PATHS.CONFIG_PATH, "utf8"),
  ) as AppConfig
  expect(stored.providers?.["my-provider"]?.manualModels).toEqual([])

  const accepted = await createApp().request(
    "/admin/config/providers/my-provider/models/manual",
    requestBody({ modelId: "working-model" }),
  )

  expect(accepted.status).toBe(200)
  stored = JSON.parse(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")) as AppConfig
  expect(stored.providers?.["my-provider"]?.manualModels).toEqual([
    "working-model",
  ])
})

test("model discovery reports healthy and pending status without exposing provider keys", async () => {
  const config = fixture()
  config.providers = {
    ...config.providers,
    "my-provider": {
      type: "openai-compatible",
      baseUrl: "https://provider.example",
      apiKey: "provider-secret",
      enabled: true,
    },
  }
  writeConfigToDisk(config)
  invalidateConfigCache()

  const response = await createApp().request(
    "/admin/config/providers/my-provider/models/discover",
    requestBody({}),
  )
  const result = (await response.json()) as {
    discoveredCount: number
    healthyCount: number
    models: Array<{ id: string; healthy: boolean; tested: boolean }>
  }

  expect(response.status).toBe(200)
  expect(result.discoveredCount).toBe(1)
  expect(result.healthyCount).toBe(1)
  expect(result.models).toEqual([
    expect.objectContaining({
      id: "discovered-model",
      healthy: true,
      tested: true,
    }) as unknown as (typeof result.models)[number],
  ])
  expect(JSON.stringify(result)).not.toContain("provider-secret")
})
